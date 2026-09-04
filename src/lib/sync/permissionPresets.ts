import type { SyncPermission } from './contracts'

/** Shared vocabulary for "how much access" across every place that grants or edits a project
 * collaborator's permissions — issuing an invitation, editing an existing grant, and resolving a
 * pending pairing request all offer the exact same three choices, so the label a collaborator sees
 * never depends on which screen was used to grant it. */
export const PERMISSION_PRESETS = [
  { id: 'viewOnly', permissions: ['read'] as SyncPermission[] },
  { id: 'reviewer', permissions: ['read', 'export'] as SyncPermission[] },
  { id: 'collaborator', permissions: ['read', 'write'] as SyncPermission[] },
] as const

export type PermissionPresetId = (typeof PERMISSION_PRESETS)[number]['id']

export const EXPIRY_CHOICES_MS = [
  { id: '1h', ms: 60 * 60 * 1000 },
  { id: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
] as const

export type ExpiryChoiceId = (typeof EXPIRY_CHOICES_MS)[number]['id']

export const SENSITIVE_PERMISSIONS: SyncPermission[] = ['write', 'delete', 'invite', 'admin']

export function matchingPresetId(permissions: readonly string[]): PermissionPresetId | null {
  const sorted = [...permissions].sort().join(',')
  const preset = PERMISSION_PRESETS.find(
    (candidate) => [...candidate.permissions].sort().join(',') === sorted,
  )
  return preset?.id ?? null
}
