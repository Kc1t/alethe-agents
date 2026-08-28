import { invoke } from '@tauri-apps/api/core'

import {
  parseProjectSyncCapabilities,
  type ProjectSyncCapabilities,
  type SyncPermission,
} from '../sync/contracts'
import { isTauriEnv, webApiFetch } from './transport'

export type SyncSecuritySnapshot = {
  schemaVersion: 1
  account: {
    accountId: string
    provider: string
    displayName: string
    emailHint?: string
    connectedAtMs: number
  } | null
  devices: Array<{
    deviceId: string
    accountId: string
    displayName: string
    publicKey: string
    publicKeyFingerprint: string
    trust: 'pending' | 'trusted' | 'revoked'
    registeredAtMs: number
    lastVerifiedAtMs?: number
    revokedAtMs?: number
    keyRotatedAtMs?: number
  }>
  localDeviceId: string | null
  invitations: Array<{
    invitationId: string
    projectId: string
    issuerDeviceId: string
    recipientAccountId: string
    recipientDeviceId?: string
    permissions: SyncPermission[]
    pathScopes: Array<{ effect: 'allow' | 'deny'; pattern: string }>
    state: 'created' | 'redeemed' | 'expired' | 'revoked'
    createdAtMs: number
    expiresAtMs: number
    redeemedAtMs?: number
    revokedAtMs?: number
  }>
  grants: Array<{
    grantId: string
    invitationId: string
    projectId: string
    accountId: string
    deviceId: string
    permissions: SyncPermission[]
    pathScopes: Array<{ effect: 'allow' | 'deny'; pattern: string }>
    issuedAtMs: number
    expiresAtMs?: number
    revokedAtMs?: number
  }>
  audit: Array<{
    sequence: number
    occurredAtMs: number
    kind: string
    actorDeviceId?: string
    targetId?: string
  }>
}

export type SyncDeviceRecord = SyncSecuritySnapshot['devices'][number]

export async function syncSecuritySnapshot(): Promise<SyncSecuritySnapshot> {
  if (isTauriEnv()) return invoke<SyncSecuritySnapshot>('sync_security_snapshot')
  return webApiFetch<SyncSecuritySnapshot>('/api/sync/security')
}

export type LocalIdentity = { deviceId: string; accountRoute: string }

export async function syncLocalIdentity(): Promise<LocalIdentity> {
  if (isTauriEnv()) return invoke<LocalIdentity>('sync_local_identity')
  return webApiFetch<LocalIdentity>('/api/sync/security/local-identity')
}

/** Desktop-only (P2P itself is Desktop-only — see `p2pBridge.ts`). Finds a trusted device ID for
 * `remoteAccountRoute` from this account's active grants, since a chat conversation member only
 * carries an account route, not a device ID, but P2P's handshake needs both. */
export async function syncFindTrustedDeviceForAccountRoute(
  remoteAccountRoute: string,
): Promise<string | null> {
  if (!isTauriEnv()) return null
  return invoke<string | null>('sync_find_trusted_device_for_account_route', {
    remoteAccountRoute,
  })
}

export async function syncApproveDevice(targetDeviceId: string): Promise<SyncDeviceRecord> {
  if (isTauriEnv()) {
    return invoke<SyncDeviceRecord>('sync_approve_device', { targetDeviceId })
  }
  return webApiFetch<SyncDeviceRecord>('/api/sync/security/devices/approve', {
    method: 'POST',
    body: JSON.stringify({ targetDeviceId }),
  })
}

export async function syncRejectDevice(targetDeviceId: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_reject_device', { targetDeviceId })
    return
  }
  await webApiFetch<void>('/api/sync/security/devices/reject', {
    method: 'POST',
    body: JSON.stringify({ targetDeviceId }),
  })
}

export async function syncRenameDevice(displayName: string): Promise<SyncDeviceRecord> {
  if (isTauriEnv()) {
    return invoke<SyncDeviceRecord>('sync_rename_device', { displayName })
  }
  return webApiFetch<SyncDeviceRecord>('/api/sync/security/devices/rename', {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  })
}

export async function syncRevokeDevice(targetDeviceId: string): Promise<SyncDeviceRecord> {
  if (isTauriEnv()) {
    return invoke<SyncDeviceRecord>('sync_revoke_device', { targetDeviceId })
  }
  return webApiFetch<SyncDeviceRecord>('/api/sync/security/devices/revoke', {
    method: 'POST',
    body: JSON.stringify({ targetDeviceId }),
  })
}

export async function syncRemoveDevice(targetDeviceId: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_remove_device', { targetDeviceId })
    return
  }
  await webApiFetch<void>('/api/sync/security/devices/remove', {
    method: 'POST',
    body: JSON.stringify({ targetDeviceId }),
  })
}

export type SyncInvitationSummary = SyncSecuritySnapshot['invitations'][number]
export type SyncGrantRecord = SyncSecuritySnapshot['grants'][number]

export type IssueInvitationRequest = {
  projectId: string
  recipientAccountId: string
  recipientDeviceId?: string
  permissions: SyncPermission[]
  pathScopes: Array<{ effect: 'allow' | 'deny'; pattern: string }>
  expiresAtMs: number
}

export type IssuedInvitationResponse = {
  invitation: SyncInvitationSummary
  bearerToken: string
}

export async function syncIssueInvitation(
  request: IssueInvitationRequest,
): Promise<IssuedInvitationResponse> {
  if (isTauriEnv()) {
    return invoke<IssuedInvitationResponse>('sync_issue_invitation', { request })
  }
  return webApiFetch<IssuedInvitationResponse>('/api/sync/security/invitations/issue', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function syncRevokeInvitation(invitationId: string): Promise<SyncInvitationSummary> {
  if (isTauriEnv()) {
    return invoke<SyncInvitationSummary>('sync_revoke_invitation', { invitationId })
  }
  return webApiFetch<SyncInvitationSummary>('/api/sync/security/invitations/revoke', {
    method: 'POST',
    body: JSON.stringify({ invitationId }),
  })
}

export async function syncRedeemInvitation(
  invitationId: string,
  bearerToken: string,
): Promise<SyncGrantRecord> {
  if (isTauriEnv()) {
    return invoke<SyncGrantRecord>('sync_redeem_invitation', {
      request: { invitationId, bearerToken },
    })
  }
  return webApiFetch<SyncGrantRecord>('/api/sync/security/invitations/redeem', {
    method: 'POST',
    body: JSON.stringify({ invitationId, bearerToken }),
  })
}

/**
 * Fetches the backend-derived capability state (Phase 3 Step 3.7). Always parsed through
 * `parseProjectSyncCapabilities`, which fails closed to fully unavailable on any malformed,
 * missing, or unexpected response — the frontend can never promote a capability by mishandling
 * this call.
 */
export async function syncResolveCapabilities(): Promise<ProjectSyncCapabilities> {
  const raw = isTauriEnv()
    ? await invoke('sync_resolve_capabilities')
    : await webApiFetch('/api/sync/security/capabilities')
  return parseProjectSyncCapabilities(raw)
}

export async function syncRevokeGrant(grantId: string): Promise<SyncGrantRecord> {
  if (isTauriEnv()) {
    return invoke<SyncGrantRecord>('sync_revoke_grant', { grantId })
  }
  return webApiFetch<SyncGrantRecord>('/api/sync/security/grants/revoke', {
    method: 'POST',
    body: JSON.stringify({ grantId }),
  })
}

export type SyncPathScope = { effect: 'allow' | 'deny'; pattern: string }

/** Updates the `permissions`/`path_scopes` of an already-active grant in place — previously the
 * only way to change a collaborator's access was revoking their grant entirely and issuing a new
 * invitation from scratch. Desktop-only for now (no Web route exists yet). */
export async function syncUpdateGrant(
  grantId: string,
  permissions: SyncPermission[],
  pathScopes: SyncPathScope[],
): Promise<SyncGrantRecord> {
  if (!isTauriEnv()) throw new Error('update_grant_desktop_only')
  return invoke<SyncGrantRecord>('sync_update_grant', { grantId, permissions, pathScopes })
}

/** Lists every non-revoked grant for a single project, instead of every grant across every
 * project this account has ever issued/received (which is all `syncSecuritySnapshot` returns). */
export async function syncListProjectGrants(projectId: string): Promise<SyncGrantRecord[]> {
  if (!isTauriEnv()) throw new Error('list_project_grants_desktop_only')
  return invoke<SyncGrantRecord[]>('sync_list_project_grants', { projectId })
}

/**
 * Rotates the local device's Ed25519 identity and X25519 agreement keys together (Phase 12).
 * Every peer that cached the old public key must re-authenticate against the new one — this call
 * only updates local state, it does not itself notify any other device.
 */
export async function syncRotateDeviceKeys(): Promise<SyncDeviceRecord> {
  if (isTauriEnv()) {
    return invoke<SyncDeviceRecord>('sync_rotate_device_keys')
  }
  return webApiFetch<SyncDeviceRecord>('/api/sync/security/devices/rotate-keys', { method: 'POST' })
}

export type SyncAccountDataExport = {
  exportedAtMs: number
  account: SyncSecuritySnapshot['account']
  devices: Array<{
    deviceId: string
    displayName: string
    publicKeyFingerprint: string
    trust: 'pending' | 'trusted' | 'revoked'
    registeredAtMs: number
    lastVerifiedAtMs?: number
    revokedAtMs?: number
    keyRotatedAtMs?: number
  }>
  invitations: Array<{
    invitationId: string
    projectId: string
    recipientAccountId: string
    state: 'created' | 'redeemed' | 'expired' | 'revoked'
    createdAtMs: number
    expiresAtMs: number
  }>
  grants: SyncGrantRecord[]
}

/**
 * Redacted export of the local account's collaboration state — no raw key bytes, no invitation
 * bearer/token-hash material, only identifiers, fingerprints, states, and timestamps. Intended
 * for a user to review or archive before deleting their account (Phase 12).
 */
export async function syncExportAccountData(): Promise<SyncAccountDataExport> {
  if (isTauriEnv()) {
    return invoke<SyncAccountDataExport>('sync_export_account_data')
  }
  return webApiFetch<SyncAccountDataExport>('/api/sync/security/account/export')
}

/**
 * Revokes every still-active grant and pending invitation for one project in a single call,
 * rather than requiring the caller to revoke each one individually (Phase 12's "project-access
 * deletion"). Returns the number of records changed; calling it again is a safe no-op.
 */
export async function syncDeleteProjectAccess(projectId: string): Promise<number> {
  if (isTauriEnv()) {
    return invoke<number>('sync_delete_project_access', { projectId })
  }
  return webApiFetch<number>('/api/sync/security/projects/delete-access', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

export type SyncChatContact = {
  accountRoute: string
  deviceId: string
  agreementPublicKey: string
  displayLabel: string
  addedAtMs: number
  /** Small downscaled profile-picture thumbnail (`data:image/jpeg;base64,...`), if known — set at
   * pairing time and refreshed live via `syncOpenAvatarUpdate`. `null`/absent if none is known. */
  avatarThumbnail?: string | null
}

export async function syncAddChatContact(
  accountRoute: string,
  deviceId: string,
  agreementPublicKey: string,
  displayLabel: string,
  avatarThumbnail?: string | null,
): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_add_chat_contact', {
      accountRoute,
      deviceId,
      agreementPublicKey,
      displayLabel,
      avatarThumbnail: avatarThumbnail ?? null,
    })
    return
  }
  await webApiFetch<void>('/api/sync/security/chat-contacts/add', {
    method: 'POST',
    body: JSON.stringify({ accountRoute, deviceId, agreementPublicKey, displayLabel }),
  })
}

export async function syncListChatContacts(): Promise<SyncChatContact[]> {
  if (isTauriEnv()) return invoke<SyncChatContact[]>('sync_list_chat_contacts')
  return webApiFetch<SyncChatContact[]>('/api/sync/security/chat-contacts/list')
}

export async function syncRenameChatContact(accountRoute: string, displayLabel: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_rename_chat_contact', { accountRoute, displayLabel })
    return
  }
  await webApiFetch('/api/sync/security/chat-contacts/rename', {
    method: 'POST',
    body: JSON.stringify({ accountRoute, displayLabel }),
  })
}

export async function syncRemoveChatContact(accountRoute: string): Promise<void> {
  if (isTauriEnv()) {
    await invoke('sync_remove_chat_contact', { accountRoute })
    return
  }
  await webApiFetch('/api/sync/security/chat-contacts/remove', {
    method: 'POST',
    body: JSON.stringify({ accountRoute }),
  })
}

/**
 * Desktop-only (same reasoning as `syncSealChatRelayMessage`): seals a "it's me, and here's my
 * single-use invite token back" acknowledgment for the issuer of a pairing code, so the issuer's
 * device can automatically add the recipient as a chat contact too — without the issuer ever
 * pasting a second code. Send the returned ciphertext through `sendRendezvousFrame` with
 * `kind: 'chat_contact_ack'`.
 */
export async function syncSealChatContactAck(
  token: string,
  accountRoute: string,
  deviceId: string,
  agreementPublicKey: string,
  displayLabel: string,
  issuerAgreementPublicKey: string,
  avatarThumbnail?: string | null,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('chat_contact_ack_desktop_only')
  return invoke<string>('sync_seal_chat_contact_ack', {
    token,
    accountRoute,
    deviceId,
    agreementPublicKey,
    displayLabel,
    issuerAgreementPublicKey,
    avatarThumbnail: avatarThumbnail ?? null,
  })
}

export type ChatContactAckResult = {
  accountRoute: string
  agreementPublicKey: string
  displayLabel: string
}

/**
 * Decrypts a delivered `chat_contact_ack` envelope and, only if its token is a still-valid,
 * unconsumed token this device itself generated, automatically adds the sender as a chat contact.
 * Returns the added contact's info, or `null` if the token didn't check out (the envelope was not
 * addressed to a currently-live invite code — ignore it). The caller must still send a
 * `chat_contact_confirm` envelope back (see `syncSealChatContactConfirm`) — the sender is waiting
 * on it before committing the contact on their own side (closes the replay gap where a pasted
 * pairing code alone used to be enough).
 */
export async function syncOpenChatContactAck(ciphertext: string): Promise<ChatContactAckResult | null> {
  if (!isTauriEnv()) throw new Error('chat_contact_ack_desktop_only')
  return invoke<ChatContactAckResult | null>('sync_open_chat_contact_ack', { ciphertext })
}

/**
 * Seals a minimal "the token checked out, go ahead and commit me as a contact" signal for whoever
 * redeemed a pairing code — send this as a `chat_contact_confirm` envelope right after
 * `syncOpenChatContactAck` returns a non-null result.
 */
export async function syncSealChatContactConfirm(recipientAgreementPublicKey: string): Promise<string> {
  if (!isTauriEnv()) throw new Error('chat_contact_confirm_desktop_only')
  return invoke<string>('sync_seal_chat_contact_confirm', { recipientAgreementPublicKey })
}

/**
 * Decrypts a delivered `chat_contact_confirm` envelope. Returns `true` only if it actually opens
 * with this device's own key — the redeeming side of `AddChatContactModal.tsx` waits for this
 * before finalizing the contact via `syncAddChatContact`.
 */
export async function syncOpenChatContactConfirm(ciphertext: string): Promise<boolean> {
  if (!isTauriEnv()) throw new Error('chat_contact_confirm_desktop_only')
  return invoke<boolean>('sync_open_chat_contact_confirm', { ciphertext })
}

/**
 * Seals `{ accountRoute, avatarThumbnail }` for a specific chat contact, to be sent as an
 * `avatar_update` rendezvous envelope whenever this device's own profile picture changes — keeps
 * that contact's stored avatar live instead of only reflecting the picture from pairing time.
 */
export async function syncSealAvatarUpdate(
  accountRoute: string,
  avatarThumbnail: string | null,
  recipientAgreementPublicKey: string,
): Promise<string> {
  if (!isTauriEnv()) throw new Error('avatar_update_desktop_only')
  return invoke<string>('sync_seal_avatar_update', {
    accountRoute,
    avatarThumbnail,
    recipientAgreementPublicKey,
  })
}

/**
 * Decrypts a delivered `avatar_update` envelope and, if the sender is a known chat contact,
 * updates their stored thumbnail. Returns the sender's account route on success, or `null` if
 * they aren't a known contact (nothing to update).
 */
export async function syncOpenAvatarUpdate(ciphertext: string): Promise<string | null> {
  if (!isTauriEnv()) throw new Error('avatar_update_desktop_only')
  return invoke<string | null>('sync_open_avatar_update', { ciphertext })
}

export type CollaboratorSuggestionEnvelope = {
  ownerAccountRoute: string
  ciphertext: string
}

/**
 * Seals a "suggest this person for the project" proposal end-to-end for the project owner (Phase
 * 12 collaboration extension). Only callable when this device holds an active grant for
 * `projectId` — proves the caller is a real collaborator. Never creates a grant or invitation
 * itself; the caller still has to send the returned ciphertext through the rendezvous relay with
 * `kind: 'invite_suggestion'`, and only the owner deciding to run the normal invite flow from
 * scratch can turn this into real access.
 */
export async function syncSuggestProjectCollaborator(
  projectId: string,
  suggestedAccountId: string,
  note: string,
): Promise<CollaboratorSuggestionEnvelope> {
  if (isTauriEnv()) {
    return invoke<CollaboratorSuggestionEnvelope>('sync_prepare_collaborator_suggestion', {
      projectId,
      suggestedAccountId,
      note,
    })
  }
  return webApiFetch<CollaboratorSuggestionEnvelope>(
    '/api/sync/security/collaborator-suggestion/prepare',
    {
      method: 'POST',
      body: JSON.stringify({ projectId, suggestedAccountId, note }),
    },
  )
}

/** Decrypts a delivered `invite_suggestion` envelope into `{ projectId, suggestedAccountId, note }` bytes. */
export async function syncOpenCollaboratorSuggestion(ciphertext: string): Promise<number[]> {
  if (isTauriEnv()) return invoke<number[]>('sync_open_collaborator_suggestion', { ciphertext })
  return webApiFetch<number[]>('/api/sync/security/collaborator-suggestion/open', {
    method: 'POST',
    body: JSON.stringify({ ciphertext }),
  })
}
