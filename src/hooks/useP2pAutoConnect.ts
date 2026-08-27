import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeRemoteCandidate,
  discoverP2pCandidate,
  p2pConnect,
  p2pSendFrame,
  prepareRemoteCandidate,
  type DiscoveredCandidate,
} from '../lib/api/p2pBridge'
import { subscribeToRendezvousEvents } from '../lib/api/rendezvousEventBus'
import { connectRendezvous, sendRendezvousFrame } from '../lib/api/syncRendezvous'
import { syncFindTrustedDeviceForAccountRoute, syncLocalIdentity } from '../lib/tauri'

export type P2pAutoConnectState = 'idle' | 'signaling' | 'p2p' | 'relay' | 'failed'

const CONNECT_RETRY_MS = 15_000
/// Upper bound on a single connect call (punch budget + Phase-4 handshake), after which the attempt
/// is abandoned so the next retry can run. Generous on purpose — this is a safety net, not the
/// normal path.
const CONNECT_ATTEMPT_TIMEOUT_MS = 45_000

/**
 * Automates, for a single already-known collaborator, the P2P signaling steps: connect the
 * rendezvous relay, discover this device's public candidate via STUN, encrypt+send it to the peer,
 * wait for the peer's candidate, then attempt a direct connection. Both sides derive the same
 * session ID deterministically from the two account routes (sorted, joined) — no manual pairing
 * needed, since chat members are already-trusted collaborators, not strangers being paired for the
 * first time.
 *
 * Falls back to `'relay'` (deliver chat messages as encrypted rendezvous envelopes instead of a
 * direct UDP session) whenever the direct attempt fails or hasn't completed yet — this only
 * degrades to `'idle'` if the rendezvous relay itself never connects.
 */
export function useP2pAutoConnect(remotePeerAccountRoute: string | null) {
  const [state, setStateRaw] = useState<P2pAutoConnectState>('idle')
  const [remoteAgreementPublicKey, setRemoteAgreementPublicKey] = useState<string | null>(null)
  const attemptedAtRef = useRef(0)
  const cancelledRef = useRef(false)
  // Guards against two `attempt()` calls overlapping — the periodic background retry below used to
  // fire every 15s regardless of whether the previous attempt (itself up to ~18s: 10s candidate
  // wait + 8s punch budget) had finished. Each attempt binds a fresh ephemeral UDP socket via
  // `discoverP2pCandidate()`, so an overlapping second attempt would rebind to a *different* local
  // port and send *that* one to the peer, abandoning the socket the peer might already be punching
  // toward — reproduced live as "received packet from unexpected source" on the receiving end, and
  // consistent punch timeouts even when the exchanged candidate looked correct at send time.
  const inFlightRef = useRef(false)
  // Reused across retries for the lifetime of this peer's session (reset only when the peer
  // changes or a fresh discovery is explicitly forced) — each `discoverP2pCandidate()` call binds
  // a brand-new ephemeral UDP socket, so rediscovering on every retry meant the candidate one side
  // advertises keeps changing round to round. Since the two sides' retries aren't synchronized,
  // a peer could receive and act on a candidate that was already stale by the time they punched:
  // reproduced live — one side's punch actually reached the other and got a reply (confirmed in the
  // receiving side's own punch log), while the sender had already moved on to a new port by then
  // and reported failure. A stable local port for the whole session avoids that staleness entirely.
  const discoveredRef = useRef<DiscoveredCandidate | null>(null)

  // Every transition, timestamped — the single clearest signal for "why did the connection state
  // change right after sending", since it's directly comparable against the timed send/relay logs
  // in ChatPanel.
  const setState: typeof setStateRaw = useCallback((next) => {
    setStateRaw((current) => {
      const resolved = typeof next === 'function' ? (next as (prev: typeof current) => typeof current)(current) : next
      if (resolved !== current) {
        console.info(`[p2p] state ${current} -> ${resolved} @ ${new Date().toISOString()}`)
      }
      return resolved
    })
  }, [])

  const attempt = useCallback(async (peerAccountRoute: string, peerAgreementPublicKey: string) => {
    const log = (...args: unknown[]) => console.info('[p2p]', `peer=${peerAccountRoute}`, ...args)
    if (inFlightRef.current) {
      log('an attempt is already in flight, skipping this one')
      return
    }
    inFlightRef.current = true
    try {
      log('connecting rendezvous relay…')
      setState('signaling')
      const status = await connectRendezvous()
      log('rendezvous connected', status)
      setState('relay')

      const remoteDeviceId = await syncFindTrustedDeviceForAccountRoute(peerAccountRoute)
      log('trusted device lookup', { remoteDeviceId })
      if (!remoteDeviceId) {
        log('no trusted device yet — staying on relay, no P2P attempt')
        return // stays 'relay' — no known trusted device yet to punch to
      }

      const identity = await syncLocalIdentity()
      const sessionId = [identity.accountRoute, peerAccountRoute].sort().join('|')
      const isInitiator = identity.accountRoute < peerAccountRoute

      let discovered = discoveredRef.current
      if (!discovered) {
        discovered = await discoverP2pCandidate()
        discoveredRef.current = discovered
        log('local candidate discovered (new)', discovered, { isInitiator, sessionId })
      } else {
        log('local candidate reused from earlier attempt', discovered, { isInitiator, sessionId })
      }
      const envelope = await prepareRemoteCandidate({
        sessionId,
        publicHost: discovered.publicHost,
        publicPort: discovered.publicPort,
        localHost: discovered.localHost,
        localPort: discovered.localPort,
        recipientAccountRoute: peerAccountRoute,
        recipientDeviceId: remoteDeviceId,
        recipientAgreementPublicKey: peerAgreementPublicKey,
      })
      await sendRendezvousFrame({
        type: 'enqueue',
        kind: 'candidate',
        id: envelope.messageId,
        recipientAccountRoute: envelope.recipientAccountRoute,
        recipientDeviceId: envelope.recipientDeviceId,
        expiresAtMs: Date.now() + 5 * 60 * 1000,
        ciphertext: envelope.ciphertext,
      })
      log('own candidate sent, waiting for the peer candidate…')

      type Candidate = { host: string; port: number; localHost: string | null; localPort: number | null }
      // Subscribes to the shared event bus instead of calling `drainRendezvousEvents()` directly —
      // that call removes events from the server-side queue as it reads them (it's a drain, not a
      // peek), so an independent direct poller here used to race with ChatPanel's/the bus's own
      // polling and could silently steal (and discard, since it wasn't looking for "candidate"
      // kind) the very delivery this loop is waiting for. See `rendezvousEventBus.ts`.
      const box: { candidate: Candidate | null } = { candidate: null }
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
          unsubscribe()
          resolve()
        }, 10_000)
        const unsubscribe = subscribeToRendezvousEvents((events) => {
          void (async () => {
            for (const event of events) {
              if (box.candidate || cancelledRef.current) return
              if (event.eventType !== 'delivery' || event.envelopeKind !== 'candidate') continue
              if (!event.ciphertext) continue
              try {
                const candidate = await consumeRemoteCandidate(event.ciphertext, sessionId)
                box.candidate = {
                  host: candidate.publicHost,
                  port: candidate.publicPort,
                  localHost: candidate.localHost,
                  localPort: candidate.localPort,
                }
                clearTimeout(timeoutId)
                unsubscribe()
                resolve()
                return
              } catch (cause) {
                log('candidate delivery did not match this session, ignoring', cause)
              }
            }
          })()
        })
      })
      if (!box.candidate) {
        log('timed out waiting for the peer candidate (10s) — staying on relay')
        return
      }
      if (cancelledRef.current) return
      const finalCandidate = box.candidate
      log('peer candidate received', finalCandidate)

      // Defence in depth for the in-flight guard: if this call ever fails to settle (it once did —
      // a peer vanishing mid-handshake blocked the backend's stream read forever), the guard would
      // stay held and silently stop every future reconnection attempt on this device. A bounded
      // wait guarantees the guard is always released, whatever happens downstream.
      const result = await Promise.race([
        p2pConnect({
          localPort: discovered.localPort,
          peerHost: finalCandidate.host,
          peerPort: finalCandidate.port,
          peerLocalHost: finalCandidate.localHost,
          peerLocalPort: finalCandidate.localPort,
          isInitiator,
          remoteAccountRoute: peerAccountRoute,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('p2p_connect_timed_out')), CONNECT_ATTEMPT_TIMEOUT_MS),
        ),
      ])
      log('p2pConnect result', result)
      if (result.connected && !cancelledRef.current) setState('p2p')
    } catch (cause) {
      log('attempt failed, falling back to relay', cause)
      if (!cancelledRef.current) setState((current) => (current === 'p2p' ? current : 'relay'))
    } finally {
      inFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    discoveredRef.current = null
    setState('idle')
    setRemoteAgreementPublicKey(null)
    if (!remotePeerAccountRoute) return
    return () => {
      cancelledRef.current = true
    }
  }, [remotePeerAccountRoute])

  const connect = useCallback(
    (peerAgreementPublicKey: string) => {
      if (!remotePeerAccountRoute) return
      const now = Date.now()
      if (now - attemptedAtRef.current < CONNECT_RETRY_MS) return
      attemptedAtRef.current = now
      setRemoteAgreementPublicKey(peerAgreementPublicKey)
      void attempt(remotePeerAccountRoute, peerAgreementPublicKey)
    },
    [remotePeerAccountRoute, attempt],
  )

  // A single attempt only has a 10s window to see the peer's candidate — if the two sides don't
  // happen to call `connect()` within ~10s of each other (the common case: one side pairs/opens
  // the chat well before the other one does), neither ever sees the other's candidate and the
  // connection permanently settles on `'relay'` for the rest of the session, even though both
  // devices are perfectly reachable. Reproduced live. Keep retrying on the same cadence as
  // `connect()`'s own throttle for as long as the chat stays open and hasn't reached `'p2p'` yet,
  // so the two sides' attempt windows eventually overlap instead of depending on a single, unlikely
  // coincidence.
  useEffect(() => {
    if (!remotePeerAccountRoute || !remoteAgreementPublicKey || state === 'p2p') return
    const timer = window.setInterval(() => {
      if (cancelledRef.current) return
      attemptedAtRef.current = Date.now()
      void attempt(remotePeerAccountRoute, remoteAgreementPublicKey)
    }, CONNECT_RETRY_MS)
    return () => window.clearInterval(timer)
  }, [remotePeerAccountRoute, remoteAgreementPublicKey, state, attempt])

  const send = useCallback(
    async (bytes: number[]) => {
      if (!remotePeerAccountRoute) throw new Error('p2p_no_peer')
      if (state === 'p2p') {
        try {
          await p2pSendFrame(remotePeerAccountRoute, bytes)
          return
        } catch (cause) {
          // The session died (e.g. the punched-through UDP path's NAT mapping expired from
          // inactivity — nothing here actively keeps it alive) — nothing was watching for this
          // before, so `state` stayed stuck on `'p2p'` forever once reached: the background retry
          // above skips entirely whenever `state === 'p2p'`, so a session that silently died left
          // the connection permanently claiming to be direct, quietly delivering everything through
          // ChatPanel's per-message relay fallback instead, and never attempting to reconnect.
          // Reproduced live ("switches to P2P, then drops"). Drop back to `'relay'` so the retry
          // loop picks the reconnection attempt back up, then let the caller's own relay fallback
          // (already in place in ChatPanel) handle this specific message.
          if (!cancelledRef.current) setState('relay')
          throw cause
        }
      }
      throw new Error('p2p_not_connected')
    },
    [remotePeerAccountRoute, state, setState],
  )

  return { state, connect, send, remoteAgreementPublicKey }
}
