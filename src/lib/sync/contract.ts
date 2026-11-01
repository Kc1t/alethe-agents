import type { SyncedProject } from '../projectSync'
import type { CloudPlan } from '../tauri/cloud'
import type { ToolingMcpServer, ToolingSkill } from '../types'

export const SYNC_FORMAT = 3

export const SYNC_SCOPES = [
  'settings',
  'projects',
  'tooling',
  'workspace',
  'stats',
  'vault',
] as const
export type SyncScope = (typeof SYNC_SCOPES)[number]

export const IMPLEMENTED_SCOPES = ['settings', 'projects', 'tooling'] as const
export type ImplementedScope = (typeof IMPLEMENTED_SCOPES)[number]

const PLAN_SCOPES: Record<CloudPlan, readonly ImplementedScope[]> = {
  free: ['settings', 'projects', 'tooling'],
  supporter: ['settings', 'projects', 'tooling'],
}

export const scopesForPlan = (plan: CloudPlan | null | undefined): readonly ImplementedScope[] =>
  PLAN_SCOPES[plan ?? 'free']

export type SettingsPayload = {
  format: number
  preferences: Record<string, unknown>
  plugins: Record<string, boolean>
}

export type ProjectsPayload = {
  format: number
  projects: Record<string, SyncedProject>
}

export type ToolingPayload = {
  format: number
  capturedAt: number | null
  mcpServers: Record<string, ToolingMcpServer>
  skills: Record<string, ToolingSkill>
}

export type ScopePayloads = {
  settings: SettingsPayload
  projects: ProjectsPayload
  tooling: ToolingPayload
}

export type SyncError =
  | 'not_connected'
  | 'session_expired'
  | 'client_outdated'
  | 'plan_required'
  | 'payload_too_large'
  | 'rate_limited'
  | 'conflict_retry_exhausted'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
