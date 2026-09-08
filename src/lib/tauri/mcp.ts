import { invoke } from '@tauri-apps/api/core'

import type { McpAgent, McpAgentSnapshot, McpCapability, McpScope, McpSourceKind } from '../types'

export type McpConfigPath = {
  agent: McpAgent
  scope: McpScope
  kind: McpSourceKind
  path: string
  exists: boolean
}

export async function mcpScan(
  scope: McpScope,
  repo?: string | null,
  agents?: McpAgent[],
): Promise<McpAgentSnapshot[]> {
  return invoke<McpAgentSnapshot[]>('mcp_scan', {
    scope,
    repo: repo ?? null,
    agents: agents ?? null,
  })
}

export async function mcpConfigPaths(
  scope: McpScope,
  repo?: string | null,
): Promise<McpConfigPath[]> {
  return invoke<McpConfigPath[]>('mcp_config_paths', { scope, repo: repo ?? null })
}

export async function mcpCapabilities(): Promise<McpCapability[]> {
  return invoke<McpCapability[]>('mcp_capabilities')
}

export type McpEnvInput = {
  key: string
  value?: string | null
  passthroughFrom?: string | null
}

export type McpTransportInput =
  | { kind: 'stdio'; command: string; args?: string[]; cwd?: string | null }
  | { kind: 'http'; url: string; headers?: McpEnvInput[] }
  | { kind: 'sse'; url: string; headers?: McpEnvInput[] }

export type McpServerInput = {
  name: string
  transport: McpTransportInput
  env?: McpEnvInput[]
  enabled?: boolean
  timeouts?: { startupSecs: number | null; toolSecs: number | null }
  bearerTokenEnvVar?: string | null
}

export type McpWriteReport = {
  path: string
  kind: McpSourceKind
  backupPath: string | null
  changed: string[]
  warnings: string[]
}

export async function mcpUpsert(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  server: McpServerInput,
  sourceKind?: McpSourceKind,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_upsert', {
    agent,
    scope,
    repo,
    server,
    sourceKind: sourceKind ?? null,
  })
}

export async function mcpRemove(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  name: string,
  sourceKind?: McpSourceKind,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_remove', {
    agent,
    scope,
    repo,
    name,
    sourceKind: sourceKind ?? null,
  })
}

export async function mcpSetEnabled(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  name: string,
  enabled: boolean,
  sourceKind?: McpSourceKind,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_set_enabled', {
    agent,
    scope,
    repo,
    name,
    enabled,
    sourceKind: sourceKind ?? null,
  })
}

export type McpUnsupportedField = {
  agent: McpAgent
  field: string
  detail: string
}

export type McpSyncOutcome = {
  agent: McpAgent
  status: 'written' | 'skipped' | 'blocked' | 'failed'
  unsupported: McpUnsupportedField[]
  error: string | null
  path: string | null
}

export async function mcpSync(
  from: McpAgent,
  to: McpAgent[],
  scope: McpScope,
  repo: string | null,
  name: string,
  overwrite = false,
): Promise<McpSyncOutcome[]> {
  return invoke<McpSyncOutcome[]>('mcp_sync', { from, to, scope, repo, name, overwrite })
}

export type McpEnvHint = {
  name: string
  description: string | null
  default: string | null
  secret: boolean
  required: boolean
}

export type McpInstallOption = {
  kind: 'stdio' | 'http' | 'sse'
  label: string
  command: string | null
  args: string[]
  url: string | null
  env: McpEnvHint[]
  headers: McpEnvHint[]
}

export type McpCatalogEntry = {
  id: string
  suggestedName: string
  title: string
  description: string
  version: string
  repositoryUrl: string | null
  installs: McpInstallOption[]
}

export type McpRegistryPage = {
  entries: McpCatalogEntry[]
  nextCursor: string | null
  /** Set when the network failed and this page came off the on-disk copy. */
  staleSince: number | null
}

export async function mcpRegistrySearch(
  query?: string,
  cursor?: string,
  limit?: number,
): Promise<McpRegistryPage> {
  return invoke<McpRegistryPage>('mcp_registry_search', {
    query: query ?? null,
    cursor: cursor ?? null,
    limit: limit ?? null,
  })
}

export type McpHealthStatus = 'connected' | 'failed' | 'needsAuth' | 'disabled' | 'unknown'

export type McpHealth = {
  name: string
  status: McpHealthStatus
}

/** Slow for Claude: it opens a connection to every server it knows about. */
export async function mcpHealthCheck(agent: McpAgent): Promise<McpHealth[]> {
  return invoke<McpHealth[]>('mcp_health_check', { agent })
}

export async function mcpRevealEnv(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  name: string,
  key: string,
  header = false,
): Promise<string> {
  return invoke<string>('mcp_reveal_env', { agent, scope, repo, name, key, header })
}
