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
