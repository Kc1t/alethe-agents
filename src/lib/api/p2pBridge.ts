import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv } from './transport'

/**
 * Desktop-only, same reasoning as `cloudflareDeploy.ts`: STUN/hole-punching happens on the
 * machine the user is sitting at, and there's no meaningful Web-mode equivalent.
 */

export type PairingCode = {
  accountId: string
  accountRoute: string
  deviceId: string
  publicKey: string
  agreementPublicKey: string
  agreementBoundAtMs: number
  agreementBindingSignature: string
}

/** Exports this device's own pairing code (public key material only) to share out of band with
 * someone on a different Google account, since there is no automated cross-account discovery. */
export async function exportPairingCode(): Promise<string> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_export_pairing_code')
}

/** Parses a pairing code pasted from the other side. Callers must still run the result through
 * `verifyDiscoveredDevice` (from `syncRendezvous.ts`) before trusting it for anything. */
export async function parsePairingCode(code: string): Promise<PairingCode> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_parse_pairing_code', { code })
}

/** The cross-device counterpart of `consumeRemoteInvitation` — use this one for a real remote
 * delivery; the original only round-trips within a single local document (see its own tests). */
export async function consumeRemoteInvitationCrossDevice(
  ciphertext: string,
  invitationId: string,
): Promise<unknown> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_consume_remote_invitation_cross_device', { ciphertext, invitationId })
}

export type OutgoingCandidateEnvelope = {
  messageId: string
  recipientAccountRoute: string
  recipientDeviceId: string | null
  ciphertext: string
}

export async function prepareRemoteCandidate(params: {
  sessionId: string
  publicHost: string
  publicPort: number
  recipientAccountRoute: string
  recipientDeviceId?: string
  recipientAgreementPublicKey: string
}): Promise<OutgoingCandidateEnvelope> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_prepare_remote_candidate', {
    sessionId: params.sessionId,
    publicHost: params.publicHost,
    publicPort: params.publicPort,
    recipientAccountRoute: params.recipientAccountRoute,
    recipientDeviceId: params.recipientDeviceId ?? null,
    recipientAgreementPublicKey: params.recipientAgreementPublicKey,
  })
}

export type RemoteCandidate = {
  sessionId: string
  publicHost: string
  publicPort: number
}

export async function consumeRemoteCandidate(
  ciphertext: string,
  sessionId: string,
): Promise<RemoteCandidate> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_consume_remote_candidate', { ciphertext, sessionId })
}

export type DiscoveredCandidate = {
  publicHost: string
  publicPort: number
  localPort: number
}

/** Binds a UDP socket and discovers its public address via STUN. `localPort` must be reused (not
 * the discovered public port) for the actual punch attempt in `p2pConnect`. */
export async function discoverP2pCandidate(): Promise<DiscoveredCandidate> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('p2p_discover_candidate')
}

export type P2pConnectResult = {
  connected: boolean
  remoteDeviceId: string | null
}

export async function p2pConnect(params: {
  localPort: number
  peerHost: string
  peerPort: number
  isInitiator: boolean
}): Promise<P2pConnectResult> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_p2p_connect', {
    localPort: params.localPort,
    peerHost: params.peerHost,
    peerPort: params.peerPort,
    isInitiator: params.isInitiator,
  })
}
