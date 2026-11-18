import { beforeEach, describe, expect, it } from 'vitest'

import { type AgentHookPayload, useAgentCanvasStore } from './agentCanvasStore'

const ingest = (payload: AgentHookPayload) => useAgentCanvasStore.getState().ingest(payload)
const backgroundNode = (taskId: string) =>
  useAgentCanvasStore.getState().nodes.find((node) => node.id === `background:${taskId}`)

function startBackgroundShell(taskId: string) {
  ingest({
    hook_event_name: 'PostToolUse',
    plannerId: 'pty-1',
    tool_name: 'Bash',
    tool_input: { command: 'sleep 6 && echo finished', run_in_background: true },
    tool_response: { backgroundTaskId: taskId },
  })
}

// What Claude Code sends as `UserPromptSubmit` when a background task ends (#239).
function taskNotification(taskId: string, status: string, summary: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    '<tool-use-id>toolu_011CkiLGevk1hTiUcCPQwXqY</tool-use-id>',
    `<output-file>C:\\Temp\\tasks\\${taskId}.output</output-file>`,
    `<status>${status}</status>`,
    `<summary>${summary}</summary>`,
    '</task-notification>',
  ].join('\n')
}

beforeEach(() => {
  useAgentCanvasStore.getState().clear()
})

describe('background shells', () => {
  it('ends a background shell when Claude reports that its task finished', () => {
    startBackgroundShell('b3f3vq4c2')
    startBackgroundShell('still-going')
    expect(backgroundNode('b3f3vq4c2')?.status).toBe('running')

    const summary = 'Background command "Sleep" completed (exit code 0)'
    ingest({
      hook_event_name: 'UserPromptSubmit',
      plannerId: 'pty-1',
      prompt: taskNotification('b3f3vq4c2', 'completed', summary),
    })

    expect(backgroundNode('b3f3vq4c2')).toMatchObject({ status: 'done', result: summary })
    expect(backgroundNode('b3f3vq4c2')?.endedAt).toEqual(expect.any(Number))
    expect(backgroundNode('still-going')?.status).toBe('running')
  })

  it('ends every task a batched notification reports, whatever its final status', () => {
    startBackgroundShell('first')
    startBackgroundShell('second')

    ingest({
      hook_event_name: 'UserPromptSubmit',
      plannerId: 'pty-1',
      prompt: `${taskNotification('first', 'failed', 'exit code 1')}\n${taskNotification('second', 'killed', 'stopped')}`,
    })

    expect(backgroundNode('first')?.status).toBe('done')
    expect(backgroundNode('second')?.status).toBe('done')
  })

  it('leaves background shells alone on an ordinary prompt', () => {
    startBackgroundShell('b3f3vq4c2')

    ingest({
      hook_event_name: 'UserPromptSubmit',
      plannerId: 'pty-1',
      prompt: 'what does <task-id>b3f3vq4c2</task-id> mean?',
    })

    expect(backgroundNode('b3f3vq4c2')?.status).toBe('running')
  })

  it('only trusts a prompt that is a notification with a final status', () => {
    startBackgroundShell('b3f3vq4c2')
    const prompts = [
      `why did this arrive?\n${taskNotification('b3f3vq4c2', 'completed', 'done')}`,
      taskNotification('b3f3vq4c2', 'running', 'still going'),
      taskNotification('b3f3vq4c2', 'completed', 'done').replace(/<status>.*<\/status>\n/, ''),
    ]

    for (const prompt of prompts) {
      ingest({ hook_event_name: 'UserPromptSubmit', plannerId: 'pty-1', prompt })
      expect(backgroundNode('b3f3vq4c2')?.status).toBe('running')
    }
  })

  it("never ends another planner's background shell", () => {
    startBackgroundShell('b3f3vq4c2')

    ingest({
      hook_event_name: 'UserPromptSubmit',
      plannerId: 'pty-2',
      prompt: taskNotification('b3f3vq4c2', 'completed', 'done'),
    })

    expect(backgroundNode('b3f3vq4c2')?.status).toBe('running')
  })

  it('keeps the summary of a shell the end of the turn already closed', () => {
    startBackgroundShell('b979hdyeo')
    ingest({ hook_event_name: 'Stop', plannerId: 'pty-1', background_tasks: [] })

    ingest({
      hook_event_name: 'UserPromptSubmit',
      plannerId: 'pty-1',
      prompt: taskNotification('b979hdyeo', 'completed', 'exit code 0'),
    })

    expect(backgroundNode('b979hdyeo')).toMatchObject({ status: 'done', result: 'exit code 0' })
  })
})

describe('end of turn reconciliation', () => {
  const node = (id: string) => useAgentCanvasStore.getState().nodes.find((entry) => entry.id === id)

  function startSubagent(agentId: string, plannerId = 'pty-1') {
    ingest({
      hook_event_name: 'SubagentStart',
      plannerId,
      agent_id: agentId,
      agent_type: 'general-purpose',
    })
  }

  // The `Stop` payload Claude Code sends at the end of the main agent's turn (#239).
  function endTurn(
    stillRunning: Array<{ id: string; type: string }> | undefined,
    plannerId = 'pty-1',
  ) {
    ingest({
      hook_event_name: 'Stop',
      plannerId,
      background_tasks: stillRunning?.map((task) => ({ ...task, status: 'running' })),
    })
  }

  it('ends every worker of the planner that is no longer running when its turn ends', () => {
    startBackgroundShell('finished-shell')
    startBackgroundShell('b979hdyeo')
    startSubagent('interrupted-subagent')
    startSubagent('aabd7e32566606b35')
    ingest({
      hook_event_name: 'PreToolUse',
      plannerId: 'pty-1',
      tool_name: 'Agent',
      tool_input: { name: 'reviewer', team_name: 'crew', prompt: 'review' },
    })

    endTurn([
      { id: 'b979hdyeo', type: 'shell' },
      { id: 'aabd7e32566606b35', type: 'subagent' },
    ])

    expect(backgroundNode('finished-shell')?.status).toBe('done')
    expect(node('interrupted-subagent')?.status).toBe('done')
    expect(node('interrupted-subagent')?.endedAt).toEqual(expect.any(Number))
    expect(backgroundNode('b979hdyeo')?.status).toBe('running')
    expect(node('aabd7e32566606b35')?.status).toBe('running')
    // Teammates outlive a turn by design.
    expect(node('teammate:reviewer')?.status).toBe('running')
  })

  it('leaves workers alone without a task list or when another planner ends its turn', () => {
    startBackgroundShell('b979hdyeo')
    startSubagent('a24fd0f1f6c372afb')

    endTurn(undefined)
    endTurn([], 'pty-2')

    expect(backgroundNode('b979hdyeo')?.status).toBe('running')
    expect(node('a24fd0f1f6c372afb')?.status).toBe('running')
  })

  it('tracks Antigravity native subagents with direct prompts and closes them on Stop', () => {
    ingest({
      hook_event_name: 'SubagentStart',
      plannerId: 'pty-agy',
      sourceAgent: 'antigravity',
      agent_id: 'call-sub-1',
      agent_type: 'Codebase Researcher',
      prompt: 'Inspect hooks configuration',
    })

    expect(node('call-sub-1')).toMatchObject({
      plannerId: 'pty-agy',
      sourceAgent: 'antigravity',
      agentType: 'Codebase Researcher',
      prompt: 'Inspect hooks configuration',
      status: 'running',
    })

    ingest({
      hook_event_name: 'SubagentStop',
      plannerId: 'pty-agy',
      sourceAgent: 'antigravity',
      agent_id: 'call-sub-1',
      last_assistant_message: 'Hooks use .agents/hooks.json',
    })

    expect(node('call-sub-1')).toMatchObject({
      status: 'done',
      result: 'Hooks use .agents/hooks.json',
    })
  })
})
