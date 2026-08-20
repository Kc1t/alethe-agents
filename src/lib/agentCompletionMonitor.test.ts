import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentCompletionMonitor } from './agentCompletionMonitor'

const ESC = '\u001b'
const BEL = '\u0007'

function submit(monitor: AgentCompletionMonitor, prompt = 'hello'): void {
  monitor.handleInput(`${prompt}\r`)
}

describe('AgentCompletionMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps generic agents working until terminal output has been idle for 4.5 seconds', () => {
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'codex-pane',
      agent: 'codex',
      notifyOnComplete: false,
      onStatusChange,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput('assistant response')

    vi.advanceTimersByTime(4_499)
    expect(onStatusChange).toHaveBeenLastCalledWith('working')
    expect(onComplete).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('completes Hermes immediately when its official TUI title reports ready', () => {
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onStatusChange,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput('assistant response')
    monitor.handleOutput(
      `${ESC}]1;✓ session title${BEL}${ESC}]2;✓ session title · model · cwd${BEL}`,
    )

    expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('recognizes a Hermes ready title split across PTY chunks', () => {
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onStatusChange,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput(`${ESC}]2;✓ session`)
    expect(onComplete).not.toHaveBeenCalled()

    monitor.handleOutput(` title · model${ESC}\\`)
    expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('recognizes a Hermes title whose OSC header is split across PTY chunks', () => {
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput(`${ESC}]`)
    monitor.handleOutput('2')
    monitor.handleOutput(`;✓ session title · model · cwd${BEL}`)

    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('stops the Hermes working indicator when the TUI is waiting for user approval', () => {
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onStatusChange,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput(`${ESC}]2;⚠ session title · model · cwd${BEL}`)

    expect(onStatusChange).toHaveBeenLastCalledWith('waiting')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('uses the final Hermes title transition when one PTY chunk contains multiple titles', () => {
    const onStatusChange = vi.fn()
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onStatusChange,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput(`${ESC}]2;✓ previous state${BEL}${ESC}]2;⏳ current state${BEL}`)

    expect(onStatusChange).toHaveBeenLastCalledWith('working')
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('cancels the silence fallback when Hermes explicitly reports that it is busy', () => {
    const onComplete = vi.fn()
    const monitor = new AgentCompletionMonitor({
      ptyId: 'hermes-pane',
      agent: 'hermes',
      notifyOnComplete: false,
      onComplete,
    })

    submit(monitor)
    monitor.handleOutput('assistant response')
    vi.advanceTimersByTime(4_000)

    monitor.handleOutput(`${ESC}]2;⏳ session title · model · cwd${BEL}`)
    vi.advanceTimersByTime(10_000)

    expect(onComplete).not.toHaveBeenCalled()
  })
})
