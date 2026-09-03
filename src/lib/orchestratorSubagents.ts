import type { AgentNode } from '../stores/agentCanvasStore'
import type { OrchestratorJob, OrchestratorJobStatus } from './tauri/orchestrator'

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
export function nativeSubagentJobs(nodes: readonly AgentNode[]): OrchestratorJob[] {
  return nodes.map((node) => ({
    id: node.id.includes(':') ? node.id : `subagent:${node.id}`,
    plannerId: node.plannerId,
    agent: node.sourceAgent,
    runId: runIdFor(node.plannerId),
    runLabel: 'Subagents',
    spec: node.prompt ?? node.agentType,
    cwd: '',
    status: statusOf(node),
    threadId: null,
    outcome: node.result,
    seconds: node.endedAt
      ? Math.round((node.endedAt - node.startedAt) / 1000)
      : Math.round((Date.now() - node.startedAt) / 1000),
    plan: [],
    tokens: null,
    quota: null,
    worktree: null,
    pendingApproval: null,
    hasDiff: false,
    summary: node.result ?? node.prompt ?? node.agentType,
    native: true,
  }))
}
