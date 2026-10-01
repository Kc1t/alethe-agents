import { describe, expect, it } from 'vitest'

import type { AgentNode } from '../stores/agentCanvasStore'
import { nativeSubagentJobs } from './orchestratorSubagents'
import type { SessionCost } from './tauri'

function node(partial: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'agent-1',
    agentType: 'general-purpose',
    kind: 'subagent',
    plannerId: 'pty-1',
    sourceAgent: 'claude',
    team: null,
    turns: 0,
    prompt: 'Review the code',
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    result: 'Done',
    transcriptPath: 'C:/sessions/agent-1.jsonl',
    feed: [],
    ...partial,
  }
}

const cost: SessionCost = {
  session_id: 'agent-1',
  agent: 'claude',
  input: 10,
  output: 20,
  cache_read: 30,
  cache_write_5m: 40,
  cache_write_1h: 50,
  total_tokens: 150,
  cost_usd: 0.015,
  model: 'claude-sonnet',
  by_model: [],
}

describe('nativeSubagentJobs', () => {
  it('attaches transcript spend to native agent jobs', () => {
    const [job] = nativeSubagentJobs([node()], { 'agent-1': cost })

    expect(job.tokens?.total).toEqual({
      totalTokens: 150,
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 30,
      cacheCreationInputTokens: 90,
    })
    expect(job.costUsd).toBe(0.015)
  })

  it('does not attribute agent spend to background shells', () => {
    const [job] = nativeSubagentJobs([node({ kind: 'background' })], { 'agent-1': cost })

    expect(job.tokens).toBeNull()
    expect(job.costUsd).toBeNull()
  })
})
