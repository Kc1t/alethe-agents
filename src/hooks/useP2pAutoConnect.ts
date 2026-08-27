import { useCallback, useEffect, useRef, useState } from 'react'

import {
  consumeRemoteCandidate,
  discoverP2pCandidate,
  p2pConnect,
  p2pSendFrame,
  prepareRemoteCandidate,
} from '../lib/api/p2pBridge'
import {
  connectRendezvous,
  drainRendezvousEvents,
  sendRendezvousFrame,
} from '../lib/api/syncRendezvous'
import { syncFindTrustedDeviceForAccountRoute, syncLocalIdentity } from '../lib/tauri'

export type P2pAutoConnectState = 'idle' | 'signaling' | 'p2p' | 'relay' | 'failed'

const CONNECT_RETRY_MS = 15_000

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

      const discovered = await discoverP2pCandidate()
      log('local candidate discovered', discovered, { isInitiator, sessionId })
      const envelope = await prepareRemoteCandidate({
        sessionId,
        publicHost: discovered.publicHost,
        publicPort: discovered.publicPort,
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

      type Candidate = { host: string; port: number }
      const box: { candidate: Candidate | null } = { candidate: null }
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline && !box.candidate && !cancelledRef.current) {
        const events = await drainRendezvousEvents()
        for (const event of events) {
          if (event.eventType !== 'delivery' || event.envelopeKind !== 'candidate') continue
          if (!event.ciphertext) continue
          try {
            const candidate = await consumeRemoteCandidate(event.ciphertext, sessionId)
            box.candidate = { host: candidate.publicHost, port: candidate.publicPort }
          } catch (cause) {
            log('candidate delivery did not match this session, ignoring', cause)
          }
        }
        if (!box.candidate) await new Promise((resolve) => setTimeout(resolve, 400))
      }
      if (!box.candidate) {
        log('timed out waiting for the peer candidate (10s) — staying on relay')
        return
      }
      if (cancelledRef.current) return
      const finalCandidate = box.candidate
      log('peer candidate received', finalCandidate)

      const result = await p2pConnect({
        localPort: discovered.localPort,
        peerHost: finalCandidate.host,
        peerPort: finalCandidate.port,
        isInitiator,
        remoteAccountRoute: peerAccountRoute,
      })
      log('p2pConnect result', result)
      if (result.connected && !cancelledRef.current) setState('p2p')
    } catch (cause) {
      log('attempt failed, falling back to relay', cause)
      if (!cancelledRef.current) setState((current) => (current === 'p2p' ? current : 'relay'))
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
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

  const send = useCallback(
    async (bytes: number[]) => {
      if (!remotePeerAccountRoute) throw new Error('p2p_no_peer')
      if (state === 'p2p') {
        await p2pSendFrame(remotePeerAccountRoute, bytes)
        return
      }
      throw new Error('p2p_not_connected')
    },
    [remotePeerAccountRoute, state],
  )

  return { state, connect, send, remoteAgreementPublicKey }
}
