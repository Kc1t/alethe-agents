import type { OrchestratorJob } from './tauri/orchestrator'

export type WorkerSettingDisplay = {
  value: string | null
  source: 'planner' | 'role' | 'fallback' | 'cli'
  role?: string
}

export function workerSettingDisplay(job: OrchestratorJob): {
  model: WorkerSettingDisplay
  effort: WorkerSettingDisplay
} {
  const source = job.routing?.verdict === 'fallback' ? 'fallback' : job.role ? 'role' : 'planner'
  const role = job.routing?.verdict === 'fallback' ? job.routing.to : job.role
  const setting = (value: string | null): WorkerSettingDisplay =>
    value === null ? { value: null, source: 'cli' } : { value, source, ...(role ? { role } : {}) }
  return { model: setting(job.model), effort: setting(job.effort) }
}
