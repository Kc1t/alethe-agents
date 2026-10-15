import { describe, expect, it, vi } from 'vitest'

import { agentInputFor, registerAgentInput } from './agentInputRegistry'

const input = () => ({
  submit: vi.fn(async () => undefined),
  interrupt: vi.fn(async () => undefined),
})

describe('agent input registry', () => {
  it('finds what a pane registered and forgets it on unregister', () => {
    const first = input()
    const unregister = registerAgentInput('pty-1', first)
    expect(agentInputFor('pty-1')).toBe(first)
    unregister()
    expect(agentInputFor('pty-1')).toBeNull()
  })

  // A respawned pane registers again under the same id before the old one cleans up.
  it('a stale unregister does not remove a newer registration', () => {
    const stale = registerAgentInput('pty-2', input())
    const fresh = input()
    registerAgentInput('pty-2', fresh)
    stale()
    expect(agentInputFor('pty-2')).toBe(fresh)
  })
})
