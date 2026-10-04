import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { AgentFitness } from '../agentFitness'
import type { OrchestratorPolicyPreferences, OrchestratorRoutingPreferences } from '../types'

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

/** `tool` is any other tool call a Claude worker asks about (web fetch, an MCP tool, ...). */
export type OrchestratorApprovalKind = 'command' | 'fileChange' | 'tool'

/** What a blocked worker is asking, with the rpc id its answer has to be sent on. */
export type OrchestratorPendingApproval = {
  rpcId: string | number
  kind: OrchestratorApprovalKind
  /** The tool's display name, for questions from a Claude worker. */
  tool?: string | null
  command: string | null
  cwd: string | null
  reason: string | null
  /** The files a change touches, or the path outside the workspace the call reaches for. */
  files?: string[]
  askedAtMs: number
}

/** `cancel` refuses and ends the worker's turn; the backend still takes the older `abort`. */
export type OrchestratorDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'

export type OrchestratorAnswer = {
  answered: string
  decision: OrchestratorDecision
}

export type OrchestratorTokenCount = {
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
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
  /**
   * `routed` is a task Alethe placed by its complexity tier. The other two describe a delegation
   * that named its own agent while one side was running out: `ignored` means the planner went into
   * the strained side with the reading in hand.
   */
  verdict: 'chosen' | 'ignored' | 'routed'
  agent: string
  /** The quota window that was running out; absent on a `routed` note. */
  window?: string
  used: number
  /** The complexity tier and kind the planner gave the task; only on a `routed` note. */
  tier?: 'light' | 'standard' | 'deep'
  kind?: string
  route?: 'primary' | 'fallback'
  /** Where the route sits in its tier's order, counted from zero. */
  position?: number
  /** The tier's primary route, when the task was moved off it because it was running out. */
  avoided?: { agent: string; used: number; rateLimited: boolean } | null
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
  /** Reported session cost. Null when the provider does not expose a monetary price. */
  costUsd: number | null
  /** Claude's per-turn usage report; null for Codex workers. */
  quota: OrchestratorClaudeQuota | null
  /** Why this worker ran on this agent; null when neither side was running out at the time. */
  routing: OrchestratorRouting | null
  worktree: string | null
  /** The oldest open question; more can be waiting behind it (`waitingApprovals`). */
  pendingApproval: OrchestratorPendingApproval | null
  waitingApprovals?: number
  hasDiff: boolean
  /** The model the worker runs on: what its CLI reported, else what it was started with. */
  model?: string | null
  /** The reasoning effort the worker runs with, when known. */
  effort?: string | null
  /** Whether this worker stops to ask before reaching outside its workspace. */
  asksForApproval?: boolean
  /** The person's rules that won over what the planner asked for this worker. */
  overrides?: string[]
  /** Its process is still up: a finished worker that can take a follow-up straight away. */
  live?: boolean
  /** Its place among the workers waiting for a slot, counted from zero; null when not waiting. */
  queuePosition?: number | null
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
  /** The worker CLIs Alethe found on this machine. */
  installedAgents?: string[]
}

const JOBS_EVENT = 'orchestrator://jobs'

/** Registers the calling terminal as a planner, so its runs can be told apart from another's. */
export async function orchestratorMcpConfigPath(
  plannerId: string,
  plannerLabel: string,
  plannerAgent: string,
  // Where the planner runs: its workers start there unless a delegation names another directory.
  plannerCwd?: string,
): Promise<string> {
  return invoke<string>('orchestrator_mcp_config_path', {
    plannerId,
    plannerLabel,
    plannerAgent,
    plannerCwd,
  })
}

/** The CLI path a worker agent runs from; null goes back to whatever PATH resolves. */
export async function orchestratorSetCliPath(agent: string, path: string | null): Promise<void> {
  return invoke<void>('orchestrator_set_cli_path', { agent, path })
}

/** Sets the model and effort workers of one CLI start with; an absent value clears it. */
export async function orchestratorSetWorkerDefaults(
  agent: string,
  defaults: { model?: string; effort?: string },
): Promise<void> {
  return invoke<void>('orchestrator_set_worker_defaults', {
    agent,
    model: defaults.model ?? null,
    effort: defaults.effort ?? null,
  })
}

export async function orchestratorJobs(): Promise<OrchestratorSnapshot> {
  return invoke<OrchestratorSnapshot>('orchestrator_jobs')
}

export async function orchestratorSetConcurrency(limit: number): Promise<void> {
  return invoke<void>('orchestrator_set_concurrency', { limit })
}

/** Pushes the person's worker rules; they apply to delegations from then on. */
export async function orchestratorSetPolicy(policy: OrchestratorPolicyPreferences): Promise<void> {
  return invoke<void>('orchestrator_set_policy', {
    defaultAgent: policy.defaultAgent,
    // Zero means no budget, as it does for a delegation's `timeoutSeconds`.
    timeoutSeconds: Math.max(0, policy.timeoutMinutes) * 60,
    approvals: policy.approvals,
    isolation: policy.isolation,
    webSearch: policy.webSearch,
    parkedLimit: policy.keepFinished,
    codexSandbox: policy.codexSandbox,
    routing: policy.routing,
  })
}

/** Stops workers that are running, queued or waiting on an approval. */
export async function orchestratorCancel(jobIds: string[]): Promise<unknown> {
  return invoke<unknown>('orchestrator_cancel', { jobIds })
}

/** Gives one planner its own routing, or returns it to the shared one with `null`. */
export async function orchestratorSetPlannerRouting(
  plannerId: string,
  routing: OrchestratorRoutingPreferences | null,
): Promise<void> {
  return invoke<void>('orchestrator_set_planner_routing', { plannerId, routing })
}

/** Puts the workers waiting for a slot in the given order; only the named ones trade places. */
export async function orchestratorReorderQueue(jobIds: string[]): Promise<unknown> {
  return invoke<unknown>('orchestrator_reorder_queue', { jobIds })
}

/** Takes finished workers off the board for good; anything still in flight is left alone. */
export async function orchestratorClear(jobIds: string[]): Promise<unknown> {
  return invoke<unknown>('orchestrator_clear', { jobIds })
}

/** Lets go of finished workers' processes; their records stay on the board. */
export async function orchestratorRelease(jobIds: string[]): Promise<unknown> {
  return invoke<unknown>('orchestrator_release', { jobIds })
}

/** Pushes an agent's remaining-limit snapshot into the orchestrator core, which cannot poll for it. */
export async function setAgentFitness(agent: string, snapshot: AgentFitness): Promise<void> {
  return invoke<void>('orchestrator_set_agent_fitness', { agent, snapshot })
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
