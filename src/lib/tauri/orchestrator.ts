import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AgentFitness } from '../agentFitness'
import type { RuleSet } from '../types'

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

export type OrchestratorRouting = {
  /** `ignored` means the planner delegated into the strained side with the reading in hand. */
  verdict: 'chosen' | 'ignored'
  agent: string
  window: string
  used: number
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
  /** Which rule set this worker was briefed with, by name; null when none applied. */
  rules: string | null
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
  /** Why this worker ran on this agent; null when neither side was running out at the time. */
  routing: OrchestratorRouting | null
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

export type OrchestratorShellStatus = 'running' | 'exited' | 'stopped'

/** Who opened a shell. Only planners do today; a worker-owned shell needs no type change. */
export type OrchestratorShellOwner = { kind: 'planner' | 'worker'; id: string }

/** A long-running command a planner started, owned by Alethe rather than by the planner. */
export type OrchestratorShell = {
  id: string
  name: string
  command: string
  cwd: string
  owner: OrchestratorShellOwner | null
  status: OrchestratorShellStatus
  exitCode: number | null
  startedAtMs: number
  /** The PTY a terminal view attaches to. */
  ptyId: string
}

export type OrchestratorShellOutput = {
  shellId: string
  status: OrchestratorShellStatus
  exitCode: number | null
  output: string
}

export type OrchestratorSnapshot = {
  jobs: OrchestratorJob[]
  planners: OrchestratorPlanner[]
  running: number
  queued: number
  concurrencyLimit: number
  shells: OrchestratorShell[]
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

/** Pushes an agent's remaining-limit snapshot into the orchestrator core, which cannot poll for it. */
export async function setAgentFitness(agent: string, snapshot: AgentFitness): Promise<void> {
  return invoke<void>('orchestrator_set_agent_fitness', { agent, snapshot })
}

/** Pushed whenever the person's sets change; an empty list means they removed them all. */
export async function orchestratorSetRuleSets(sets: RuleSet[]): Promise<void> {
  return invoke<void>('orchestrator_set_rule_sets', { sets })
}

export async function orchestratorDefaultRuleSets(): Promise<RuleSet[]> {
  return invoke<RuleSet[]>('orchestrator_default_rule_sets')
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

/** Interrupts a running worker and settles it as cancelled — the same path `alethe_cancel` takes. */
export async function orchestratorCancelJob(jobId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_cancel_job', { jobId })
}

export async function orchestratorShellOutput(
  shellId: string,
  lines: number,
): Promise<OrchestratorShellOutput> {
  return invoke<OrchestratorShellOutput>('orchestrator_shell_output', { shellId, lines })
}

/** Ctrl+C first, the whole process tree after five seconds. */
export async function orchestratorShellStop(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_stop', { shellId })
}

/** Restarts a running shell, or runs one that exited or was stopped again. */
export async function orchestratorShellRestart(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_restart', { shellId })
}

export async function orchestratorShellRemove(shellId: string): Promise<unknown> {
  return invoke<unknown>('orchestrator_shell_remove', { shellId })
}

export async function listenOrchestratorJobs(
  handler: (snapshot: OrchestratorSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<OrchestratorSnapshot>(JOBS_EVENT, (event) => handler(event.payload))
}
