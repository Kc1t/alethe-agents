import type { AgentNode } from '../stores/agentCanvasStore'
import type { OrchestratorJob, OrchestratorJobStatus } from './tauri/orchestrator'
import type { SessionCost } from './tauri/sessions'

function statusOf(node: AgentNode): OrchestratorJobStatus {
  return node.status === 'running' ? 'running' : 'done'
}

function runIdFor(plannerId: string | null): string {
  return `native-subagents:${plannerId ?? 'none'}`
}

/**
 * Claude's own subagents/teammates (SubagentStart/Stop hooks, `agentCanvasStore`) reshaped as
 * `OrchestratorJob`s, so they flow through the same `groupPlanners`/`layoutPlannerBoard` pipeline as
 * delegated Codex workers and land on the same planner tree, one shared "Subagents" run per planner.
 */
export function nativeSubagentJobs(
  nodes: readonly AgentNode[],
  costs: Readonly<Record<string, SessionCost>> = {},
): OrchestratorJob[] {
  return nodes.map((node) => {
    const cost = node.kind === 'background' ? undefined : costs[node.id]
    return {
      id: node.id.includes(':') ? node.id : `subagent:${node.id}`,
      plannerId: node.plannerId,
      agent: node.sourceAgent,
      runId: runIdFor(node.plannerId),
      runLabel: 'Subagents',
      // A native subagent never went through delegation, so no rule set was briefed to it.
      rules: null,
      spec: node.prompt ?? node.agentType,
      cwd: '',
      status: statusOf(node),
      threadId: null,
      outcome: node.result,
      // Alethe never picked an agent for these: the planner spawned them inside its own process.
      routing: null,
      seconds: node.endedAt
        ? Math.round((node.endedAt - node.startedAt) / 1000)
        : Math.round((Date.now() - node.startedAt) / 1000),
      plan: [],
      tokens: cost
        ? {
            total: {
              totalTokens: cost.total_tokens,
              inputTokens: cost.input,
              outputTokens: cost.output,
              cachedInputTokens: cost.cache_read,
              cacheCreationInputTokens: cost.cache_write_5m + cost.cache_write_1h,
            },
          }
        : null,
      costUsd: cost?.cost_usd ?? null,
      quota: null,
      worktree: null,
      pendingApproval: null,
      hasDiff: false,
      summary: node.result ?? node.prompt ?? node.agentType,
      native: true,
    }
  })
}
