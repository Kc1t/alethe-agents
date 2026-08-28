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
  /** Single-use invite token embedded by the issuer — see `syncSealChatContactAck`. */
  inviteToken: string
  /** The issuer's own rendezvous endpoint (Worker URL), if they have one configured/enabled. */
  rendezvousEndpoint: string | null
  /** The issuer's own profile display name, if set — used to pre-fill the contact's name. */
  displayName: string | null
  /** The issuer's own profile picture, already downscaled to a small thumbnail — see
   * `downscaleAvatar.ts`. `null` if they have no picture set. */
  avatarThumbnail: string | null
}

/** Exports this device's own pairing code (public key material only) to share out of band with
 * someone on a different Google account, since there is no automated cross-account discovery. */
export async function exportPairingCode(
  displayName?: string | null,
  avatarThumbnail?: string | null,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_export_pairing_code', {
    displayName: displayName ?? null,
    avatarThumbnail: avatarThumbnail ?? null,
  })
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
  /** This device's LAN-facing address, if known — see `DiscoveredCandidate.localHost`. Lets a
   * same-LAN peer punch through instantly instead of relying on the public/STUN address, which
   * cannot be reached from inside the same router (no NAT hairpinning on most consumer gear).
   * Carries its own port (`localPort`) — the router almost always rewrites the port too, so this
   * is NOT the same number as `publicPort`. */
  localHost?: string | null
  localPort?: number | null
  recipientAccountRoute: string
  recipientDeviceId?: string
  recipientAgreementPublicKey: string
}): Promise<OutgoingCandidateEnvelope> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_prepare_remote_candidate', {
    sessionId: params.sessionId,
    publicHost: params.publicHost,
    publicPort: params.publicPort,
    localHost: params.localHost ?? null,
    localPort: params.localPort ?? null,
    recipientAccountRoute: params.recipientAccountRoute,
    recipientDeviceId: params.recipientDeviceId ?? null,
    recipientAgreementPublicKey: params.recipientAgreementPublicKey,
  })
}

export type RemoteCandidate = {
  sessionId: string
  publicHost: string
  publicPort: number
  localHost: string | null
  localPort: number | null
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
  /** This device's LAN-facing IP, best-effort (`null` if it could not be determined). */
  localHost: string | null
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
  /** The peer's LAN-facing address, if they reported one — tried before `peerHost` (see
   * `prepareRemoteCandidate`'s `localHost` doc comment). */
  peerLocalHost?: string | null
  peerLocalPort?: number | null
  isInitiator: boolean
  remoteAccountRoute: string
}): Promise<P2pConnectResult> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  return invoke('sync_p2p_connect', {
    localPort: params.localPort,
    peerHost: params.peerHost,
    peerPort: params.peerPort,
    peerLocalHost: params.peerLocalHost ?? null,
    peerLocalPort: params.peerLocalPort ?? null,
    isInitiator: params.isInitiator,
    remoteAccountRoute: params.remoteAccountRoute,
  })
}

/** Sends raw bytes over an already-`connected` P2P session (see `p2pConnect`), keyed by the
 * remote peer's account route. Fails with `p2p_session_not_found`/`p2p_session_closed` instead of
 * silently dropping the frame if there is no live session for that route. */
export async function p2pSendFrame(remoteAccountRoute: string, frame: number[]): Promise<void> {
  if (!isTauriEnv()) throw new Error('p2p_desktop_only')
  await invoke('p2p_send_frame', { remoteAccountRoute, frame })
}

/** Drains (removes) every frame received on the session for `remoteAccountRoute` since the last
 * call — call this on a short interval while a chat conversation with that peer is open. */
export async function p2pDrainFrames(remoteAccountRoute: string): Promise<number[][]> {
  if (!isTauriEnv()) return []
  return invoke('p2p_drain_frames', { remoteAccountRoute })
}

export type P2pSessionState = 'connected' | 'closed'

export async function p2pSessionState(remoteAccountRoute: string): Promise<P2pSessionState> {
  if (!isTauriEnv()) return 'closed'
  return invoke('p2p_session_state', { remoteAccountRoute })
}
