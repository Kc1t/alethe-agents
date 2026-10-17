import { describe, expect, it, vi } from 'vitest'

vi.mock('./notifications', () => ({ notifyAgentDone: vi.fn() }))

import { AgentCompletionMonitor } from './agentCompletionMonitor'

describe('AgentCompletionMonitor.armForSubmit', () => {
  it('marks the pane working for a prompt that never went through the keyboard', () => {
    const onStatusChange = vi.fn()
    const monitor = new AgentCompletionMonitor({ ptyId: 'p', agent: 'claude', onStatusChange })
    monitor.armForSubmit('  run the tests  ')
    expect(onStatusChange).toHaveBeenCalledWith('working')
  })

  it('ignores an empty prompt and a disposed monitor', () => {
    const onStatusChange = vi.fn()
    const monitor = new AgentCompletionMonitor({ ptyId: 'p', agent: 'claude', onStatusChange })
    monitor.armForSubmit('   ')
    monitor.dispose()
    monitor.armForSubmit('hello')
    expect(onStatusChange).not.toHaveBeenCalled()
  })
})
