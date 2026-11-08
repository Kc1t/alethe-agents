import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('./notifications', () => ({ notifyAgentDone: vi.fn(async () => {}) }))
vi.mock('./agentProviders', () => ({ agentLabel: (agent: string) => agent }))
import { AgentCompletionMonitor } from './agentCompletionMonitor'
afterEach(() => vi.useRealTimers())

describe('plugin prompt completion monitoring', () => {
  it('arms an explicitly submitted prompt without interpreting bracketed-paste bytes as keyboard input', async () => {
    vi.useFakeTimers()
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'pty-monitor',
      agent: 'opencode',
      onStatusChange,
      onComplete,
      notifyOnComplete: false,
    })
    try {
      monitor.armForSubmit('hello')
      expect(onStatusChange).toHaveBeenCalledWith('working')
      await vi.advanceTimersByTimeAsync(500)
      monitor.handleOutput('Completed the requested implementation.')
      await vi.advanceTimersByTimeAsync(4500)
      expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
      expect(onComplete).toHaveBeenCalledOnce()
    } finally {
      monitor.dispose()
    }
  })

  it('does not arm empty submissions or a disposed monitor', () => {
    const onStatusChange = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'pty-monitor',
      agent: 'codex',
      onStatusChange,
    })
    monitor.armForSubmit('   ')
    monitor.dispose()
    monitor.armForSubmit('hello')
    expect(onStatusChange).not.toHaveBeenCalled()
  })
})
