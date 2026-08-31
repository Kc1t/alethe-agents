import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeRemoteCandidate,
  discoverP2pCandidate,
  p2pConnect,
  p2pSendFrame,
  p2pSessionState,
  prepareRemoteCandidate,
  type DiscoveredCandidate,
  type NatClass,
} from '../lib/api/p2pBridge'
import { P2P_CHANNEL_CHAT, tagFrame } from '../lib/api/p2pChannel'
import { subscribeToRendezvousEvents } from '../lib/api/rendezvousEventBus'
import { connectRendezvous, sendRendezvousFrame } from '../lib/api/syncRendezvous'
import {
  githubSignalingCleanupSession,
  githubSignalingHasToken,
  githubSignalingPollCandidate,
  githubSignalingPublishCandidate,
} from '../lib/api/syncRendezvousGit'
import { syncFindTrustedDeviceForAccountRoute, syncLocalIdentity } from '../lib/tauri'

export type P2pAutoConnectState = 'idle' | 'signaling' | 'p2p' | 'relay' | 'failed'

const CONNECT_RETRY_MS = 15_000
/// Upper bound on a single connect call (punch budget + Phase-4 handshake), after which the attempt
/// is abandoned so the next retry can run. Generous on purpose — this is a safety net, not the
/// normal path.
const CONNECT_ATTEMPT_TIMEOUT_MS = 45_000
/// How long a single attempt waits for a *fresh* peer candidate when the retained inbox is empty.
const CANDIDATE_WAIT_MS = 10_000
/// Cap on retained candidate ciphertexts — only the newest matter (a candidate describes a
/// currently-bound socket), and this stops a peer that keeps retrying from growing the list without
/// bound while we can't decrypt any of them.
const CANDIDATE_INBOX_MAX = 8

/** Publishes this device's own candidate to its signaling Gist and polls the peer's Gist for
 * theirs, for up to `GITHUB_FALLBACK_WAIT_MS` — only reached after the primary Cloudflare wait
 * already timed out (see the call site), so this never adds latency to the common case where
 * Cloudflare delivers the candidate normally. Returns `null` (not a throw) on any failure — a
 * broken/unconfigured fallback must never be worse than not having tried it, so a rejected token
 * or an unreachable GitHub API just means "stay on relay," same as if this fallback did not
 * exist. */
async function tryGithubSignalingFallback(params: {
  log: (...args: unknown[]) => void
  sessionId: string
  localDeviceId: string
  localGistId: string
  peerGistId: string
  ownEnvelopeCiphertext: string
}): Promise<{ host: string; port: number; localHost: string | null; localPort: number | null; natClass: NatClass | null } | null> {
  const { log, sessionId, localDeviceId, localGistId, peerGistId, ownEnvelopeCiphertext } = params
  try {
    if (!(await githubSignalingHasToken())) return null
    log('primary relay candidate wait timed out — trying the GitHub signaling fallback')
    await githubSignalingPublishCandidate({
      gistId: localGistId,
      sessionId,
      senderDeviceId: localDeviceId,
      ciphertext: ownEnvelopeCiphertext,
    })
    const deadline = Date.now() + GITHUB_FALLBACK_WAIT_MS
    while (Date.now() < deadline) {
      const ciphertext = await githubSignalingPollCandidate({ gistId: peerGistId, sessionId, localDeviceId })
      if (ciphertext) {
        const candidate = await consumeRemoteCandidate(ciphertext, sessionId)
        log('peer candidate received via the GitHub signaling fallback')
        return {
          host: candidate.publicHost,
          port: candidate.publicPort,
          localHost: candidate.localHost,
          localPort: candidate.localPort,
          natClass: candidate.natClass,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, GITHUB_FALLBACK_POLL_INTERVAL_MS))
    }
    log(`GitHub signaling fallback also timed out after ${GITHUB_FALLBACK_WAIT_MS / 1000}s`)
    return null
  } catch (cause) {
    log('GitHub signaling fallback failed, staying on relay', cause)
    return null
  }
}

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
export type P2pNatInfo = { local: NatClass; peer: NatClass | null }

/// Extra window given to the GitHub Gist fallback after the primary Cloudflare candidate wait
/// (`CANDIDATE_WAIT_MS`) times out — only spent when the fallback is actually configured
/// (`localGistId`/`peerGistId` both present and a GitHub token is stored), so a session with no
/// fallback configured never waits any longer than before this existed.
const GITHUB_FALLBACK_WAIT_MS = 10_000
const GITHUB_FALLBACK_POLL_INTERVAL_MS = 2_000

export function useP2pAutoConnect(
  remotePeerAccountRoute: string | null,
  /** This device's own signaling Gist id (see `syncRendezvousGit.ts`'s `githubSignalingCreateGist`)
   * and the peer's, as learned from the pairing invitation. Either being `null`/`undefined`
   * disables the GitHub fallback entirely for this peer — Cloudflare remains the only signaling
   * path in that case, exactly as before this fallback existed. */
  gistIds?: { local: string | null; peer: string | null },
) {
  const [state, setStateRaw] = useState<P2pAutoConnectState>('idle')
  const [remoteAgreementPublicKey, setRemoteAgreementPublicKey] = useState<string | null>(null)
  // Additive to the state machine above, not a replacement — reflects the last NAT classification
  // seen for this peer, for callers (e.g. `ChatPanel`) that want to explain *why* a direct
  // connection is unavailable rather than just showing "relay".
  const [natInfo, setNatInfo] = useState<P2pNatInfo | null>(null)
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
  // Candidate ciphertexts seen by the always-on subscription below, newest last, kept so an
  // attempt can consume one that arrived *before* it started waiting. See that subscription's
  // comment for why retaining them is required for correctness, not just an optimisation.
  const candidateInboxRef = useRef<string[]>([])
  // Set while an attempt is inside its candidate wait, so a candidate arriving mid-wait wakes it
  // immediately instead of only being noticed on the next poll.
  const candidateWaiterRef = useRef<(() => void) | null>(null)

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
        natClass: discovered.natClass,
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

      type Candidate = {
        host: string
        port: number
        localHost: string | null
        localPort: number | null
        natClass: NatClass | null
      }
      // Drains the retained inbox (filled by the always-on subscription) rather than only watching
      // for candidates that happen to arrive during this call's own wait window.
      const takeCandidateFromInbox = async (): Promise<Candidate | null> => {
        while (candidateInboxRef.current.length > 0) {
          const ciphertext = candidateInboxRef.current.shift()
          if (!ciphertext) continue
          try {
            const candidate = await consumeRemoteCandidate(ciphertext, sessionId)
            return {
              host: candidate.publicHost,
              port: candidate.publicPort,
              localHost: candidate.localHost,
              localPort: candidate.localPort,
              natClass: candidate.natClass,
            }
          } catch (cause) {
            log('candidate delivery did not match this session, ignoring', cause)
          }
        }
        return null
      }

      let candidate = await takeCandidateFromInbox()
      if (candidate) {
        log('peer candidate taken from the retained inbox (arrived before this attempt)')
      } else {
        log(`no retained candidate, waiting up to ${CANDIDATE_WAIT_MS / 1000}s for a fresh one…`)
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => {
            candidateWaiterRef.current = null
            resolve()
          }, CANDIDATE_WAIT_MS)
          candidateWaiterRef.current = () => {
            clearTimeout(timeoutId)
            candidateWaiterRef.current = null
            resolve()
          }
        })
        candidate = await takeCandidateFromInbox()
      }
      if (!candidate && gistIds?.local && gistIds?.peer) {
        candidate = await tryGithubSignalingFallback({
          log,
          sessionId,
          localDeviceId: identity.deviceId,
          localGistId: gistIds.local,
          peerGistId: gistIds.peer,
          ownEnvelopeCiphertext: envelope.ciphertext,
        })
      }
      if (!candidate) {
        log(
          `timed out waiting for the peer candidate (${CANDIDATE_WAIT_MS / 1000}s) — staying on relay. ` +
            'The peer is not sending one (their chat is closed, or their relay is down).',
        )
        return
      }
      if (cancelledRef.current) return
      const finalCandidate = candidate
      log('peer candidate received', finalCandidate)
      setNatInfo({ local: discovered.natClass, peer: finalCandidate.natClass })

      // Both sides classified their network as symmetric NAT with confidence — a hole punch
      // cannot succeed here (see the Rust `NatClass::Symmetric` doc comment), so skip straight to
      // relay instead of waiting out the full punch/handshake timeout below for an attempt that is
      // already known to fail.
      if (discovered.natClass === 'symmetric' && finalCandidate.natClass === 'symmetric') {
        log('both sides are behind symmetric NAT — skipping the punch attempt, staying on relay')
        return
      }

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
          localNatClass: discovered.natClass,
          peerNatClass: finalCandidate.natClass,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('p2p_connect_timed_out')), CONNECT_ATTEMPT_TIMEOUT_MS),
        ),
      ])
      log('p2pConnect result', result)
      if (result.connected && !cancelledRef.current) {
        setState('p2p')
        if (gistIds?.local) {
          // Best-effort — the entry also self-expires (see `sync_rendezvous_git.rs`'s
          // `CANDIDATE_TTL_MS`), so a failure here just means slightly more dead weight in the
          // Gist until it expires on its own, not a correctness problem.
          void githubSignalingCleanupSession(gistIds.local, sessionId).catch(() => {})
        }
      }
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
    candidateInboxRef.current = []
    setState('idle')
    setRemoteAgreementPublicKey(null)
    setNatInfo(null)
    if (!remotePeerAccountRoute) return
    return () => {
      cancelledRef.current = true
    }
  }, [remotePeerAccountRoute])

  // Retains every `candidate` envelope for the whole time this peer's chat is open, instead of only
  // while an attempt happens to be inside its wait window.
  //
  // `drainRendezvousEvents()` is destructive (see `rendezvousEventBus.ts`): the bus keeps draining
  // continuously because ChatPanel's chat_message listener is always subscribed. An attempt used to
  // subscribe only for its 10s wait, so a candidate delivered during the ~5s gap between attempts
  // was drained, offered only to listeners that ignore that kind, and lost permanently. Since both
  // sides retry on the same fixed 15s period, once the two sides' phases drifted apart they could
  // never realign — the connection then stayed on relay forever while both devices were perfectly
  // reachable, reporting only "timed out waiting for the peer candidate". Reproduced live from the
  // captured logs of both machines.
  useEffect(() => {
    if (!remotePeerAccountRoute) return
    return subscribeToRendezvousEvents((events) => {
      for (const event of events) {
        if (event.eventType !== 'delivery' || event.envelopeKind !== 'candidate') continue
        if (!event.ciphertext) continue
        candidateInboxRef.current.push(event.ciphertext)
        if (candidateInboxRef.current.length > CANDIDATE_INBOX_MAX) candidateInboxRef.current.shift()
        console.info(
          `[p2p] peer=${remotePeerAccountRoute} candidate envelope retained (inbox=${candidateInboxRef.current.length})`,
        )
        candidateWaiterRef.current?.()
      }
    })
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

  // Watches a live session for death instead of only discovering it when a send fails. The backend
  // thread marks a session closed as soon as its socket errors, but nothing asked: a session that
  // died during a quiet stretch left the UI claiming "P2P direto" indefinitely, and — because the
  // reconnect loop above skips entirely while `state === 'p2p'` — no reconnection was ever
  // attempted either. Dropping back to `'relay'` here is what lets that loop resume.
  useEffect(() => {
    if (state !== 'p2p' || !remotePeerAccountRoute) return
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const sessionState = await p2pSessionState(remotePeerAccountRoute)
          if (sessionState !== 'connected' && !cancelledRef.current) {
            console.info(`[p2p] peer=${remotePeerAccountRoute} session reported "${sessionState}" — dropping back to relay`)
            setState('relay')
          }
        } catch (cause) {
          console.info(`[p2p] peer=${remotePeerAccountRoute} session liveness check failed`, cause)
        }
      })()
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [state, remotePeerAccountRoute, setState])

  const send = useCallback(
    async (bytes: number[]) => {
      if (!remotePeerAccountRoute) throw new Error('p2p_no_peer')
      if (state === 'p2p') {
        try {
          // Tagged so the receiving side's single drain loop can tell this apart from a file-sync
          // frame sharing the same underlying P2P session — see `p2pChannel.ts`.
          await p2pSendFrame(remotePeerAccountRoute, tagFrame(P2P_CHANNEL_CHAT, bytes))
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

  return { state, connect, send, remoteAgreementPublicKey, natInfo }
}
