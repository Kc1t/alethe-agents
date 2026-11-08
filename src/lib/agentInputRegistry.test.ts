import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentInputFor, registerAgentInput, waitForAgentInput } from './agentInputRegistry'

const input = () => ({
  submit: vi.fn(async () => {}),
  interrupt: vi.fn(async () => {}),
  readScreen: () => 'screen',
})
afterEach(() => vi.useRealTimers())

describe('mounted agent input', () => {
  it('keeps the newest registration when an older mount disposes', () => {
    const first = registerAgentInput('pty-registry', input())
    const next = input()
    const second = registerAgentInput('pty-registry', next)
    first()
    expect(agentInputFor('pty-registry')).toBe(next)
    second()
    expect(agentInputFor('pty-registry')).toBeNull()
  })

  it('waits for a hidden sub-tab to mount and settle its screen', async () => {
    vi.useFakeTimers()
    const next = input()
    let mounted = false
    const pending = waitForAgentInput('pty-registry', () => (mounted ? next : null))
    await vi.advanceTimersByTimeAsync(100)
    mounted = true
    await vi.advanceTimersByTimeAsync(400)
    expect(await pending).toBe(next)
  })

  it('returns null when the terminal never mounts', async () => {
    vi.useFakeTimers()
    const pending = waitForAgentInput('pty-registry', () => null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBeNull()
  })
})
