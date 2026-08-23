import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type OrchestratorJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'released'

export type OrchestratorTokenCount = {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  reasoningOutputTokens?: number
}

export type OrchestratorTokens = {
  total?: OrchestratorTokenCount
  last?: OrchestratorTokenCount
  modelContextWindow?: number
}

export type OrchestratorJob = {
  id: string
  spec: string
  cwd: string
  status: OrchestratorJobStatus
  threadId: string | null
  outcome: string | null
  seconds: number | null
  plan: string[]
  tokens: OrchestratorTokens | null
  worktree: string | null
  hasDiff: boolean
  summary: string
}

export type OrchestratorSnapshot = {
  jobs: OrchestratorJob[]
  running: number
  queued: number
  concurrencyLimit: number
}

const JOBS_EVENT = 'orchestrator://jobs'

export async function orchestratorMcpConfigPath(): Promise<string> {
  return invoke<string>('orchestrator_mcp_config_path')
}

export async function orchestratorJobs(): Promise<OrchestratorSnapshot> {
  return invoke<OrchestratorSnapshot>('orchestrator_jobs')
}

export async function orchestratorSetConcurrency(limit: number): Promise<void> {
  return invoke<void>('orchestrator_set_concurrency', { limit })
}

/** `steer` bends the turn already running; without it the message becomes the worker's next turn. */
export async function orchestratorMessage(
  jobId: string,
  message: string,
  steer: boolean,
): Promise<unknown> {
  return invoke<unknown>('orchestrator_message', { jobId, message, steer })
}

export async function listenOrchestratorJobs(
  handler: (snapshot: OrchestratorSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<OrchestratorSnapshot>(JOBS_EVENT, (event) => handler(event.payload))
}
