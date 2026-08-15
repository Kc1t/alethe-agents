import { invoke } from '@tauri-apps/api/core'

import type { McpAgent, McpAgentSnapshot, McpCapability, McpScope } from '../types'

export type McpConfigPath = {
  agent: McpAgent
  scope: McpScope
  path: string | null
  exists: boolean
  supported: boolean
}

export async function mcpScan(
  scope: McpScope,
  repo?: string | null,
  agents?: McpAgent[],
): Promise<McpAgentSnapshot[]> {
  return invoke<McpAgentSnapshot[]>('mcp_scan', { scope, repo: repo ?? null, agents: agents ?? null })
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
  backupPath: string | null
  changed: string[]
  warnings: string[]
}

export async function mcpUpsert(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  server: McpServerInput,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_upsert', { agent, scope, repo, server })
}

export async function mcpRemove(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  name: string,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_remove', { agent, scope, repo, name })
}

export async function mcpSetEnabled(
  agent: McpAgent,
  scope: McpScope,
  repo: string | null,
  name: string,
  enabled: boolean,
): Promise<McpWriteReport> {
  return invoke<McpWriteReport>('mcp_set_enabled', { agent, scope, repo, name, enabled })
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
