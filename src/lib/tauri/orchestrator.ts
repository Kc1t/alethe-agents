import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type OrchestratorJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'released'

export type OrchestratorJob = {
  id: string
  spec: string
  cwd: string
  status: OrchestratorJobStatus
  threadId: string | null
  outcome: string | null
  seconds: number | null
  plan: string[]
  tokens: unknown
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

export async function listenOrchestratorJobs(
  handler: (jobs: OrchestratorJob[]) => void,
): Promise<UnlistenFn> {
  return listen<{ jobs: OrchestratorJob[] }>(JOBS_EVENT, (event) => {
    handler(event.payload.jobs ?? [])
  })
}
