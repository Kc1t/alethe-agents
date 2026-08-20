import { invoke } from '@tauri-apps/api/core'

import type { ModelCost } from './sessions'
import { isTauriEnv, webApiFetch } from './transport'

export type ClaudeUsageWindow = { utilization: number; resets_at: string }
export type ClaudeUsage = {
  five_hour: ClaudeUsageWindow
  seven_day: ClaudeUsageWindow
  seven_day_opus: ClaudeUsageWindow
}
export type CodexUsageWindow = {
  used_percent: number
  window_minutes: number
  resets_at_ms: number
}
export type CodexUsage = {
  primary: CodexUsageWindow
  secondary: CodexUsageWindow
  plan: string
  rate_limited: boolean
  reset_credits: number
}
export type AntigravityQuotaBucket = {
  label: string
  models: string[]
  used_percent: number
  remaining_percent: number
  resets_at: string
}
export type AntigravityUsage = {
  status: 'ready' | 'no_cli' | 'no_auth' | 'unavailable'
  cli_path: string
  used_percent: number
  rate_limited: boolean
  buckets: AntigravityQuotaBucket[]
}
export type ModelRate = {
  family: string
  input: number
  output: number
  cache_write_5m: number
  cache_write_1h: number
  cache_read: number
}
export type OpenCodeUsageSummary = {
  cost_usd: number
  input_tokens: number
  output_tokens: number
  session_count: number
  by_model: ModelCost[]
}
export type ActivityDay = { date: string; count: number }
export type ActivityAgentSample = {
  agent: Exclude<import('../types').AgentType, 'shell'>
  projectId: string | null
  terminalId: string | null
  state: 'working' | 'waiting'
}
export type ActivitySample = {
  date: string
  durationMs: number
  appFocused: boolean
  userActive: boolean
  activeProjectId: string | null
  activeTerminalId: string | null
  agents: ActivityAgentSample[]
}
export type ActivityTimeTotals = {
  appOpenMs: number
  appFocusedMs: number
  userActiveMs: number
  userIdleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
  peakConcurrent: number
}
export type AgentTimeStats = {
  workingMs: number
  waitingMs: number
  focusedMs: number
  backgroundMs: number
}
export type ProjectTimeStats = {
  focusedMs: number
  activeMs: number
  idleMs: number
  agentWallMs: number
  agentSumMs: number
  agentBackgroundMs: number
  parallelMs: number
}
export type ActivitySummary = {
  totals: ActivityTimeTotals
  agents: Record<string, AgentTimeStats>
  projects: Record<string, ProjectTimeStats>
}

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  if (isTauriEnv()) return invoke<ClaudeUsage>('get_claude_usage')
  return webApiFetch<ClaudeUsage>('/api/usage/claude')
}

const EMPTY_CODEX_WINDOW: CodexUsageWindow = {
  used_percent: 0,
  window_minutes: 0,
  resets_at_ms: 0,
}

export async function getCodexUsage(): Promise<CodexUsage> {
  if (isTauriEnv()) return invoke<CodexUsage>('get_codex_usage')
  try {
    return await webApiFetch<CodexUsage>('/api/usage/codex')
  } catch {
    return {
      primary: EMPTY_CODEX_WINDOW,
      secondary: EMPTY_CODEX_WINDOW,
      plan: '',
      rate_limited: false,
      reset_credits: 0,
    }
  }
}

export async function getAntigravityUsage(): Promise<AntigravityUsage> {
  if (isTauriEnv()) return invoke<AntigravityUsage>('get_antigravity_usage')
  return webApiFetch<AntigravityUsage>('/api/usage/antigravity')
}

export async function getModelPricing(): Promise<ModelRate[]> {
  if (isTauriEnv()) return invoke<ModelRate[]>('get_model_pricing')
  return webApiFetch<ModelRate[]>('/api/usage/pricing')
}

export async function getOpenCodeUsageSummary(hours: number): Promise<OpenCodeUsageSummary> {
  if (isTauriEnv()) return invoke<OpenCodeUsageSummary>('get_opencode_usage_summary', { hours })
  return webApiFetch<OpenCodeUsageSummary>(`/api/usage/opencode_summary?hours=${hours}`)
}

export async function getClaudeActivity(days = 91): Promise<ActivityDay[]> {
  if (isTauriEnv()) return invoke<ActivityDay[]>('get_claude_activity', { days }).catch(() => [])
  return webApiFetch<ActivityDay[]>(`/api/usage/claude_activity?days=${days}`).catch(() => [])
}

export async function getMultiAgentActivity(days: number): Promise<ActivityDay[]> {
  if (isTauriEnv())
    return invoke<ActivityDay[]>('get_multi_agent_activity', { days }).catch(() => [])
  return webApiFetch<ActivityDay[]>(`/api/usage/multi_agent_activity?days=${days}`).catch(() => [])
}

export async function recordActivitySamples(samples: ActivitySample[]): Promise<void> {
  if (isTauriEnv()) return invoke('record_activity_samples', { samples })
}

export async function getActivitySummary(dates: string[] = []): Promise<ActivitySummary> {
  if (isTauriEnv()) return invoke<ActivitySummary>('get_activity_summary', { dates })
  return webApiFetch<ActivitySummary>('/api/usage/summary', {
    method: 'POST',
    body: JSON.stringify({ dates }),
  })
}

export async function clearActivityStats(): Promise<void> {
  if (isTauriEnv()) return invoke('clear_activity_stats')
  await webApiFetch('/api/usage/clear_stats', { method: 'POST' })
}
