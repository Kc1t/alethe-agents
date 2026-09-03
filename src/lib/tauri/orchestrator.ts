import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type OrchestratorJobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'released'
  // The process died with the app, but the thread survived on disk, so the work can be picked up
  // again. Neither a failure nor a result.
  | 'interrupted'
  // Stopped on a question only a person can answer, still holding its slot. Neither settled nor a
  // failure.
  | 'blocked'

export type OrchestratorApprovalKind = 'command' | 'fileChange'

/** What a blocked worker is asking, with the rpc id its answer has to be sent on. */
export type OrchestratorPendingApproval = {
  rpcId: string | number
  kind: OrchestratorApprovalKind
  command: string | null
  cwd: string | null
  reason: string | null
  askedAtMs: number
}

export type OrchestratorDecision = 'accept' | 'acceptForSession' | 'decline' | 'abort'

export type OrchestratorAnswer = {
  answered: string
  decision: OrchestratorDecision
}

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

export type OrchestratorClaudeQuota = {
  status: 'allowed' | 'rejected' | string
  resetsAt: number | null
  rateLimitType: string
  overageStatus?: string
  isUsingOverage?: boolean
}

export type OrchestratorJob = {
  id: string
  /** The terminal whose agent asked for this work; null for calls made outside a terminal. */
  plannerId: string | null
  /** Which CLI runs the worker itself. */
  agent: string
  /** One delegation call is one run; workers from different rounds group by this. */
  runId: string
  runLabel: string | null
  spec: string
  cwd: string
  status: OrchestratorJobStatus
  threadId: string | null
  outcome: string | null
  seconds: number | null
  plan: string[]
  tokens: OrchestratorTokens | null
  /** Claude's per-turn usage report; null for Codex workers. */
  quota: OrchestratorClaudeQuota | null
  worktree: string | null
  pendingApproval: OrchestratorPendingApproval | null
  hasDiff: boolean
  summary: string
  /** Set only on the frontend, for a Claude/Codex native subagent reshaped into this type — it never
   * had a real backend job, so steering/resuming/messaging it has nothing to reach. */
  native?: boolean
}

export type OrchestratorPlanner = {
  id: string
  label: string
  agent: string
}

export type OrchestratorSnapshot = {
  jobs: OrchestratorJob[]
  planners: OrchestratorPlanner[]
  running: number
  queued: number
  concurrencyLimit: number
}

const JOBS_EVENT = 'orchestrator://jobs'

/** Registers the calling terminal as a planner, so its runs can be told apart from another's. */
export async function orchestratorMcpConfigPath(
  plannerId: string,
  plannerLabel: string,
  plannerAgent: string,
): Promise<string> {
  return invoke<string>('orchestrator_mcp_config_path', {
    plannerId,
    plannerLabel,
    plannerAgent,
  })
}

export async function orchestratorJobs(): Promise<OrchestratorSnapshot> {
  return invoke<OrchestratorSnapshot>('orchestrator_jobs')
}

export async function orchestratorSetConcurrency(limit: number): Promise<void> {
  return invoke<void>('orchestrator_set_concurrency', { limit })
}

/** The unified diff a worker has produced so far — the same text `alethe_diff` hands the planner. */
export async function orchestratorJobDiff(jobId: string): Promise<string> {
  return invoke<string>('orchestrator_job_diff', { jobId })
}

/** Answers the request a blocked worker is stopped on. Rejects when it is not waiting on one. */
export async function orchestratorAnswer(
  jobId: string,
  decision: OrchestratorDecision,
): Promise<OrchestratorAnswer> {
  return invoke<OrchestratorAnswer>('orchestrator_answer', { jobId, decision })
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
