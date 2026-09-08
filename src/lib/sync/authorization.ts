import type {
  AccountId,
  DeviceId,
  GrantId,
  InvitationId,
  ProjectSyncId,
  SyncPermission,
} from './contracts'
import { normalizePermissions, PROJECT_SYNC_PROTOCOL_VERSION } from './contracts'

export type PermissionPreset =
  'view-only' | 'view-and-copy' | 'collaborate' | 'upload-only' | 'full-control'

export const PERMISSION_PRESETS: Record<PermissionPreset, SyncPermission[]> = {
  'view-only': ['read'],
  'view-and-copy': ['read', 'export'],
  collaborate: ['read', 'write'],
  'upload-only': ['upload'],
  'full-control': ['read', 'export', 'write', 'delete', 'invite', 'admin'],
}

export type PathScope = { effect: 'allow' | 'deny'; pattern: string }

export type EnforcedProjectGrant = {
  id: GrantId
  projectId: ProjectSyncId
  subject: { accountId: AccountId; deviceId?: DeviceId }
  permissions: SyncPermission[]
  pathScopes: PathScope[]
  issuedAt: number
  expiresAt?: number
  revokedAt?: number
}

export type ProjectOperation =
  'manifest' | 'read' | 'export' | 'write' | 'upload' | 'delete' | 'invite' | 'admin'

export type AuthorizationRequest = {
  projectId: ProjectSyncId
  accountId: AccountId
  deviceId: DeviceId
  operation: ProjectOperation
  relativePath?: string
  now?: number
}

export type AuthorizationDecision =
  | { allowed: true; permission: SyncPermission }
  | {
      allowed: false
      reason:
        | 'wrong_project'
        | 'wrong_subject'
        | 'device_not_granted'
        | 'expired'
        | 'revoked'
        | 'permission_denied'
        | 'invalid_path'
        | 'path_denied'
    }

export type InvitationRecord = {
  protocolVersion: typeof PROJECT_SYNC_PROTOCOL_VERSION
  id: InvitationId
  projectId: ProjectSyncId
  issuerDeviceId: DeviceId
  audience: { accountId: AccountId; deviceId?: DeviceId }
  permissions: SyncPermission[]
  pathScopes: PathScope[]
  tokenHash: string
  state: 'created' | 'accepted' | 'redeemed' | 'expired' | 'revoked'
  createdAt: number
  expiresAt: number
  acceptedAt?: number
  redeemedAt?: number
  revokedAt?: number
}

const OPERATION_PERMISSION: Record<ProjectOperation, SyncPermission> = {
  manifest: 'read',
  read: 'read',
  export: 'export',
  write: 'write',
  upload: 'upload',
  delete: 'delete',
  invite: 'invite',
  admin: 'admin',
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hashesEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

export function normalizeRelativeSyncPath(value: string): string | null {
  if (!value || value.includes('\0') || /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith('/')) {
    return null
  }
  const parts = value.replace(/\\/gu, '/').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function scopeMatches(pattern: string, path: string): boolean {
  const normalized = normalizeRelativeSyncPath(pattern.replace(/\/\*\*$/u, '/placeholder'))
  if (!normalized) return false
  if (pattern.endsWith('/**')) {
    const prefix = normalized.slice(0, -'/placeholder'.length)
    return path === prefix || path.startsWith(`${prefix}/`)
  }
  return normalized === path
}

function pathAllowed(scopes: readonly PathScope[], path: string): boolean {
  if (
    scopes.some((scope) => {
      const probe = scope.pattern.endsWith('/**')
        ? scope.pattern.replace(/\/\*\*$/u, '/placeholder')
        : scope.pattern
      return normalizeRelativeSyncPath(probe) === null
    })
  ) {
    return false
  }
  if (scopes.some((scope) => scope.effect === 'deny' && scopeMatches(scope.pattern, path))) {
    return false
  }
  const allowScopes = scopes.filter((scope) => scope.effect === 'allow')
  return allowScopes.length === 0 || allowScopes.some((scope) => scopeMatches(scope.pattern, path))
}

export function authorizeProjectOperation(
  grant: EnforcedProjectGrant,
  request: AuthorizationRequest,
): AuthorizationDecision {
  if (grant.projectId !== request.projectId) return { allowed: false, reason: 'wrong_project' }
  if (grant.subject.accountId !== request.accountId) {
    return { allowed: false, reason: 'wrong_subject' }
  }
  if (grant.subject.deviceId && grant.subject.deviceId !== request.deviceId) {
    return { allowed: false, reason: 'device_not_granted' }
  }
  if (grant.revokedAt) return { allowed: false, reason: 'revoked' }
  if (grant.expiresAt && (request.now ?? Date.now()) > grant.expiresAt) {
    return { allowed: false, reason: 'expired' }
  }
  const permission = OPERATION_PERMISSION[request.operation]
  if (!normalizePermissions(grant.permissions).includes(permission)) {
    return { allowed: false, reason: 'permission_denied' }
  }
  if (request.relativePath !== undefined) {
    const path = normalizeRelativeSyncPath(request.relativePath)
    if (!path) return { allowed: false, reason: 'invalid_path' }
    if (!pathAllowed(grant.pathScopes, path)) return { allowed: false, reason: 'path_denied' }
  }
  return { allowed: true, permission }
}

export async function issueInvitation(input: {
  id: InvitationId
  projectId: ProjectSyncId
  issuerDeviceId: DeviceId
  audience: InvitationRecord['audience']
  permissions: SyncPermission[]
  pathScopes?: PathScope[]
  now?: number
  expiresAt: number
}): Promise<{ invitation: InvitationRecord; token: string }> {
  const now = input.now ?? Date.now()
  if (input.expiresAt <= now) throw new Error('invitation_expiry_invalid')
  const token = randomToken()
  return {
    token,
    invitation: {
      protocolVersion: PROJECT_SYNC_PROTOCOL_VERSION,
      id: input.id,
      projectId: input.projectId,
      issuerDeviceId: input.issuerDeviceId,
      audience: input.audience,
      permissions: normalizePermissions(input.permissions),
      pathScopes: input.pathScopes ?? [],
      tokenHash: await hashToken(token),
      state: 'created',
      createdAt: now,
      expiresAt: input.expiresAt,
    },
  }
}

export async function redeemInvitation(
  invitation: InvitationRecord,
  token: string,
  recipient: { accountId: AccountId; deviceId: DeviceId },
  now = Date.now(),
): Promise<{ invitation: InvitationRecord; grant: EnforcedProjectGrant } | null> {
  if (invitation.state !== 'created' && invitation.state !== 'accepted') return null
  if (now > invitation.expiresAt) return null
  if (invitation.audience.accountId !== recipient.accountId) return null
  if (invitation.audience.deviceId && invitation.audience.deviceId !== recipient.deviceId)
    return null
  if (!hashesEqual(await hashToken(token), invitation.tokenHash)) return null

  return {
    invitation: { ...invitation, state: 'redeemed', acceptedAt: now, redeemedAt: now },
    grant: {
      id: `grant-${String(invitation.id)}` as GrantId,
      projectId: invitation.projectId,
      subject: recipient,
      permissions: invitation.permissions,
      pathScopes: invitation.pathScopes,
      issuedAt: now,
      expiresAt: invitation.expiresAt,
    },
  }
}

export function revokeInvitation(invitation: InvitationRecord, now = Date.now()): InvitationRecord {
  if (invitation.state === 'redeemed') throw new Error('invitation_already_redeemed')
  return { ...invitation, state: 'revoked', revokedAt: invitation.revokedAt ?? now }
}
