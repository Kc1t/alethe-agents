import { invoke } from '@tauri-apps/api/core'

import type { SyncPermission } from '../sync/contracts'
import type { SyncGrantRecord } from './syncSecurity'
import { isTauriEnv, webApiFetch } from './transport'

export type CollaborationServiceMode = 'local_only' | 'alethe_managed' | 'advanced_custom'
export type CollaborationActivationState =
  | 'disabled'
  | 'identity_required'
  | 'ready'
  | 'connecting'
  | 'online'
  | 'retrying'
  | 'direct_only'
  | 'needs_attention'

export type CollaborationServiceSettings = {
  mode: CollaborationServiceMode
  enabled: boolean
  customEndpoint: string | null
  validatedEndpoint: string | null
  compatibleProtocolMin: number | null
  compatibleProtocolMax: number | null
  updatedAtMs: number
}

export type RendezvousStatus = {
  state:
    | 'no_attempt_yet'
    | 'connecting'
    | 'online'
    | 'retrying_after_transient_failure'
    | 'direct_session_only'
    | 'provider_failure'
  queuedEvents: number
  endpointConfigured: boolean
}

export async function getCollaborationServiceSettings(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_get_activation_settings')
  return webApiFetch('/api/sync/activation')
}

export async function setCollaborationServiceMode(
  mode: CollaborationServiceMode,
  customEndpoint?: string,
): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_set_activation_mode', { mode, customEndpoint })
  return webApiFetch('/api/sync/activation/mode', {
    method: 'POST',
    body: JSON.stringify({ mode, customEndpoint }),
  })
}

export async function enableCollaborationService(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_enable_activation')
  return webApiFetch('/api/sync/activation/enable', { method: 'POST' })
}

export async function disableCollaborationService(): Promise<CollaborationServiceSettings> {
  if (isTauriEnv()) return invoke('sync_disable_activation')
  return webApiFetch('/api/sync/activation/disable', { method: 'POST' })
}

export async function resolveCollaborationActivationState(): Promise<CollaborationActivationState> {
  if (isTauriEnv()) return invoke('sync_resolve_activation_state')
  return webApiFetch('/api/sync/activation/state')
}

export async function validateRendezvousEndpoint(endpoint: string): Promise<void> {
  if (isTauriEnv()) return invoke('sync_rendezvous_validate_endpoint', { endpoint })
  return webApiFetch('/api/sync/rendezvous/validate', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  })
}

/**
 * Adopts a rendezvous endpoint discovered from someone else (a chat contact's pairing code) as
 * this device's own, but only if this device doesn't already have one configured and enabled —
 * never overrides an existing setup. Best-effort: the caller should ignore failures, since the
 * contact was still added successfully either way.
 */
export async function adoptDiscoveredRendezvousEndpoint(endpoint: string): Promise<void> {
  if (isTauriEnv()) return invoke('sync_adopt_discovered_endpoint', { endpoint })
  return webApiFetch('/api/sync/rendezvous/adopt-discovered-endpoint', {
    method: 'POST',
    body: JSON.stringify({ endpoint }),
  })
}

export async function connectRendezvous(): Promise<RendezvousStatus> {
  if (isTauriEnv()) return invoke('sync_rendezvous_connect')
  return webApiFetch('/api/sync/rendezvous/connect', { method: 'POST' })
}

export async function disconnectRendezvous(): Promise<void> {
  if (isTauriEnv()) return invoke('sync_rendezvous_disconnect')
  return webApiFetch('/api/sync/rendezvous/disconnect', { method: 'POST' })
}

export async function getRendezvousStatus(): Promise<RendezvousStatus> {
  if (isTauriEnv()) return invoke('sync_rendezvous_status')
  return webApiFetch('/api/sync/rendezvous/status')
}

/**
 * Sends a raw rendezvous control frame (`{ type: "enqueue" | "ack" | "pull" | "discover", ... }`)
 * over the live connection. The server-side allowlist in `sync_rendezvous.rs` rejects any
 * unknown field or malformed shape — this call is a thin passthrough, not a place to add new
 * validation.
 */
export async function sendRendezvousFrame(frame: Record<string, unknown>): Promise<void> {
  if (isTauriEnv()) return invoke('sync_rendezvous_send', { frame })
  return webApiFetch('/api/sync/rendezvous/send', {
    method: 'POST',
    body: JSON.stringify({ frame }),
  })
}

export type RendezvousEvent = {
  eventType: 'delivery' | 'devices' | 'error'
  messageId: string | null
  envelopeKind:
    | 'invitation'
    | 'candidate'
    | 'revocation'
    | 'chat_message'
    | 'invite_suggestion'
    | 'chat_contact_ack'
    | 'chat_contact_confirm'
    | 'avatar_update'
    | 'bio_update'
    | null
  senderDeviceId: string | null
  ciphertext: string | null
  expiresAtMs: number | null
  devices: unknown[] | null
}

export async function drainRendezvousEvents(): Promise<RendezvousEvent[]> {
  if (isTauriEnv()) return invoke('sync_rendezvous_drain_events')
  return webApiFetch('/api/sync/rendezvous/events')
}

export type DiscoveredDevice = {
  deviceId: string
  publicKey: string
  agreementPublicKey: string
  agreementBoundAtMs: number
  agreementBindingSignature: string
}

/**
 * Verifies a device discovered via `{ type: 'discover' }` (see `drainRendezvousEvents`'s
 * `eventType: 'devices'` entries) actually owns the X25519 key it advertised, by checking the
 * Ed25519 signature binding the two keys together. The rendezvous service is untrusted — it can
 * forward this binding but never forge one, since it never holds any device's Ed25519 private
 * key. Returns the verified key (base64url) ready to pass to `prepareRemoteInvitation`; throws if
 * the binding does not check out.
 */
export async function verifyDiscoveredDevice(device: DiscoveredDevice): Promise<string> {
  if (isTauriEnv()) return invoke('sync_verify_discovered_device', { device })
  return webApiFetch('/api/sync/invitations/bridge/verify-device', {
    method: 'POST',
    body: JSON.stringify(device),
  })
}

export type OutgoingInvitationEnvelope = {
  messageId: string
  recipientAccountRoute: string
  recipientDeviceId: string | null
  expiresAtMs: number
  ciphertext: string
}

/**
 * Encrypts an already-issued local invitation (from `syncIssueInvitation`) for a specific
 * recipient device's X25519 public key. The caller is responsible for then sending the returned
 * envelope through `sendRendezvousFrame({ type: "enqueue", kind: "invitation", ... })` — this
 * call never touches the network itself (Phase 10B invitation bridge).
 */
export async function prepareRemoteInvitation(params: {
  invitationId: string
  bearerToken: string
  projectId: string
  permissions: SyncPermission[]
  pathScopes: Array<{ effect: 'allow' | 'deny'; pattern: string }>
  expiresAtMs: number
  createdAtMs: number
  recipientAccountRoute: string
  recipientDeviceId?: string
  recipientAgreementPublicKey: string
}): Promise<OutgoingInvitationEnvelope> {
  if (isTauriEnv()) {
    return invoke('sync_prepare_remote_invitation', {
      invitationId: params.invitationId,
      bearerToken: params.bearerToken,
      projectId: params.projectId,
      permissions: params.permissions,
      pathScopes: params.pathScopes,
      expiresAtMs: params.expiresAtMs,
      createdAtMs: params.createdAtMs,
      recipientAccountRoute: params.recipientAccountRoute,
      recipientDeviceId: params.recipientDeviceId ?? null,
      recipientAgreementPublicKey: params.recipientAgreementPublicKey,
    })
  }
  return webApiFetch('/api/sync/invitations/bridge/prepare', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}

/**
 * Decrypts a delivered invitation event (from `drainRendezvousEvents`, filtered to
 * `envelopeKind === 'invitation'`) using the local device's own X25519 agreement secret, and
 * redeems it into a grant — the remote counterpart of `syncRedeemInvitation`.
 */
export async function consumeRemoteInvitation(
  ciphertext: string,
  invitationId: string,
): Promise<SyncGrantRecord> {
  if (isTauriEnv()) return invoke('sync_consume_remote_invitation', { ciphertext, invitationId })
  return webApiFetch('/api/sync/invitations/bridge/consume', {
    method: 'POST',
    body: JSON.stringify({ ciphertext, invitationId }),
  })
}
