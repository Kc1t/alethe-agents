import { invoke } from '@tauri-apps/api/core'

import { isTauriEnv, webApiFetch } from './transport'

export type AntigravitySessionSnapshot = {
  id: string
  preview: string
  modified_at_ms: number
}

export type ModelCost = {
  model: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  cost_usd: number | null
}

export type SessionCost = {
  session_id: string
  agent: string
  input: number
  output: number
  cache_read: number
  cache_write_5m: number
  cache_write_1h: number
  total_tokens: number
  cost_usd: number | null
  model: string | null
  by_model: ModelCost[]
}

export type ClaudeSessionMeta = {
  id: string
  title: string | null
  first_user_prompt: string | null
  message_count: number
  modified_at_ms: number
  size_bytes: number
}

export type ClaudeSessionSnapshot = { id: string; modified_at_ms: number; size_bytes: number }
export type CodexSessionSnapshot = {
  id: string
  cwd: string
  modified_at_ms: number
  size_bytes: number
}
export type OpenCodeSessionSnapshot = { id: string; modified_at_ms: number }

export type OpenCodeExportPartBase = { id: string; sessionID: string; messageID: string }
export type OpenCodeExportTextPart = OpenCodeExportPartBase & { type: 'text'; text: string }
export type OpenCodeExportReasoningPart = OpenCodeExportPartBase & {
  type: 'reasoning'
  text?: string
}
export type OpenCodeExportToolPart = OpenCodeExportPartBase & {
  type: 'tool'
  tool: string
  callID: string
  state: {
    status: string
    input?: Record<string, unknown>
    output?: string
    time?: { start?: number; end?: number }
  }
}
export type OpenCodeExportPatchPart = OpenCodeExportPartBase & {
  type: 'patch'
  hash?: string
  files?: Record<string, unknown>
}
export type OpenCodeExportStepPart = {
  type: 'step-start' | 'step-finish'
  reason?: string
  tokens?: { input?: number; output?: number; total?: number }
}

export type OpenCodeExportPart =
  | OpenCodeExportTextPart
  | OpenCodeExportReasoningPart
  | OpenCodeExportToolPart
  | OpenCodeExportPatchPart
  | OpenCodeExportStepPart

export type OpenCodeExportMessage = {
  info: {
    role: 'user' | 'assistant'
    time: { created: number; completed?: number }
    agent?: string
    model?: { providerID?: string; modelID?: string }
    id: string
    sessionID: string
  }
  parts: OpenCodeExportPart[]
}

export type OpenCodeExportSession = {
  info: {
    id: string
    slug?: string
    title?: string
    agent?: string
    model?: { id?: string; providerID?: string; variant?: string }
    version?: string
    tokens?: {
      input: number
      output: number
      reasoning?: number
      cache?: { read: number; write: number }
    }
    cost?: number
    time: { created: number; updated: number }
  }
  messages: OpenCodeExportMessage[]
}

export async function snapshotAntigravitySessions(
  cwd: string,
): Promise<AntigravitySessionSnapshot[]> {
  if (isTauriEnv())
    return invoke<AntigravitySessionSnapshot[]>('snapshot_antigravity_sessions', { cwd })
  return webApiFetch<AntigravitySessionSnapshot[]>(
    `/api/sessions/antigravity/snapshot?cwd=${encodeURIComponent(cwd)}`,
  )
}

export async function getSessionCost(
  agent: string,
  cwd: string,
  sessionId: string,
): Promise<SessionCost> {
  if (isTauriEnv()) return invoke<SessionCost>('get_session_cost', { agent, cwd, sessionId })
  return webApiFetch<SessionCost>(
    `/api/sessions/cost?agent=${encodeURIComponent(agent)}&cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
  )
}

export async function getTranscriptCost(path: string): Promise<SessionCost> {
  if (isTauriEnv()) return invoke<SessionCost>('get_transcript_cost', { path })
  return webApiFetch<SessionCost>(`/api/sessions/transcript_cost?path=${encodeURIComponent(path)}`)
}

export async function snapshotClaudeSessions(cwd: string): Promise<ClaudeSessionSnapshot[]> {
  if (isTauriEnv()) return invoke<ClaudeSessionSnapshot[]>('snapshot_claude_sessions', { cwd })
  return webApiFetch<ClaudeSessionSnapshot[]>(
    `/api/sessions/claude/snapshot?cwd=${encodeURIComponent(cwd)}`,
  )
}

export async function snapshotCodexSessions(cwd: string): Promise<CodexSessionSnapshot[]> {
  if (isTauriEnv()) return invoke<CodexSessionSnapshot[]>('snapshot_codex_sessions', { cwd })
  return webApiFetch<CodexSessionSnapshot[]>(
    `/api/sessions/codex/snapshot?cwd=${encodeURIComponent(cwd)}`,
  )
}

export async function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  if (isTauriEnv()) return invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })
  return webApiFetch<ClaudeSessionMeta[]>(
    `/api/sessions/claude/list?cwd=${encodeURIComponent(cwd)}`,
  )
}

export async function snapshotOpenCodeSessions(cwd: string): Promise<OpenCodeSessionSnapshot[]> {
  if (isTauriEnv()) return invoke<OpenCodeSessionSnapshot[]>('snapshot_opencode_sessions', { cwd })
  return webApiFetch<OpenCodeSessionSnapshot[]>(
    `/api/sessions/opencode/snapshot?cwd=${encodeURIComponent(cwd)}`,
  )
}

export async function opencodeExportSession(
  cwd: string,
  sessionId: string,
): Promise<OpenCodeExportSession> {
  if (isTauriEnv())
    return invoke<OpenCodeExportSession>('opencode_export_session', { cwd, sessionId })
  return webApiFetch<OpenCodeExportSession>(
    `/api/sessions/opencode/export?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`,
  )
}
