export const PROJECT_SYNC_PROTOCOL_VERSION = 1 as const

type Brand<Value, Name extends string> = Value & { readonly __brand: Name }

export type AccountId = Brand<string, 'AccountId'>
export type DeviceId = Brand<string, 'DeviceId'>
export type ProjectSyncId = Brand<string, 'ProjectSyncId'>
export type InvitationId = Brand<string, 'InvitationId'>
export type GrantId = Brand<string, 'GrantId'>

export type SyncPermission = 'read' | 'export' | 'write' | 'upload' | 'delete' | 'manage'
export type CapabilityState = 'unavailable' | 'experimental' | 'available'

export type ProjectSyncCapabilities = {
  protocolVersion: typeof PROJECT_SYNC_PROTOCOL_VERSION
  identity: CapabilityState
  deviceTrust: CapabilityState
  invitations: CapabilityState
  projectTransfer: CapabilityState
  sharedTasks: CapabilityState
  projectChat: CapabilityState
  verifiedEncryption: boolean
}

export type IdentityState =
  | { status: 'disconnected' }
  | { status: 'authorizing'; attemptId: string; expiresAt: number }
  | { status: 'connected'; accountId: AccountId; displayName: string }
  | { status: 'error'; code: string; retryable: boolean }

export type DeviceTrustState = 'pending' | 'trusted' | 'revoked'
export type InvitationState = 'created' | 'accepted' | 'redeemed' | 'expired' | 'revoked'

export type RegisteredDevice = {
  id: DeviceId
  accountId: AccountId
  displayName: string
  publicKeyFingerprint: string
  trust: DeviceTrustState
  firstSeenAt: number
  lastSeenAt?: number
}

export type ProjectInvitation = {
  id: InvitationId
  projectId: ProjectSyncId
  issuerDeviceId: DeviceId
  audience: { accountId: AccountId; deviceId?: DeviceId }
  permissions: SyncPermission[]
  state: InvitationState
  expiresAt: number
  protocolVersion: typeof PROJECT_SYNC_PROTOCOL_VERSION
}

export type ProjectGrant = {
  id: GrantId
  projectId: ProjectSyncId
  subject: { accountId: AccountId; deviceId?: DeviceId }
  permissions: SyncPermission[]
  issuedAt: number
  expiresAt?: number
  revokedAt?: number
}

export type RecipientTransferConsent = {
  projectId: ProjectSyncId
  destinationPath: string
  manifestRevision: string
  acceptedAt: number
}

export const unavailableProjectSyncCapabilities = (): ProjectSyncCapabilities => ({
  protocolVersion: PROJECT_SYNC_PROTOCOL_VERSION,
  identity: 'unavailable',
  deviceTrust: 'unavailable',
  invitations: 'unavailable',
  projectTransfer: 'unavailable',
  sharedTasks: 'unavailable',
  projectChat: 'unavailable',
  verifiedEncryption: false,
})

export const PROJECT_SYNC_CAPABILITIES = unavailableProjectSyncCapabilities()

const CAPABILITY_STATES = new Set<CapabilityState>(['unavailable', 'experimental', 'available'])

export function parseProjectSyncCapabilities(value: unknown): ProjectSyncCapabilities {
  if (!value || typeof value !== 'object') return unavailableProjectSyncCapabilities()
  const candidate = value as Record<string, unknown>
  const stateKeys = [
    'identity',
    'deviceTrust',
    'invitations',
    'projectTransfer',
    'sharedTasks',
    'projectChat',
  ] as const

  if (
    candidate.protocolVersion !== PROJECT_SYNC_PROTOCOL_VERSION ||
    candidate.verifiedEncryption !== false ||
    stateKeys.some((key) => !CAPABILITY_STATES.has(candidate[key] as CapabilityState))
  ) {
    return unavailableProjectSyncCapabilities()
  }

  return candidate as ProjectSyncCapabilities
}

export function normalizePermissions(permissions: readonly SyncPermission[]): SyncPermission[] {
  const normalized = new Set(permissions)
  if (normalized.has('export') || normalized.has('write') || normalized.has('delete')) {
    normalized.add('read')
  }
  if (normalized.has('manage')) {
    normalized.add('read')
  }
  return [...normalized]
}
