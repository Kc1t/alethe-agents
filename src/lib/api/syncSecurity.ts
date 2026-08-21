import { invoke } from '@tauri-apps/api/core'

import type { SyncPermission } from '../sync/contracts'
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

export async function syncSecuritySnapshot(): Promise<SyncSecuritySnapshot> {
  if (isTauriEnv()) return invoke<SyncSecuritySnapshot>('sync_security_snapshot')
  return webApiFetch<SyncSecuritySnapshot>('/api/sync/security')
}
