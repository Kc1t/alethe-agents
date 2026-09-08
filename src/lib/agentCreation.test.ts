import { describe, expect, it } from 'vitest'

import {
  AGENT_OPTIONS,
  createUnrestrictedAgentState,
  SHELL_FIRST_AGENT_OPTIONS,
  unrestrictedArgsForAgent,
} from './agentCreation'

describe('agent creation helpers', () => {
  it('keeps every supported agent in the shared picker contract', () => {
    expect(AGENT_OPTIONS.map((agent) => agent.type)).toEqual([
      'claude',
      'codex',
      'copilot',
      'antigravity',
      'opencode',
      'mimo',
      'freebuff',
      'shell',
    ])
    expect(SHELL_FIRST_AGENT_OPTIONS[0].type).toBe('shell')
  })

  it('creates independent permission state and only emits supported flags', () => {
    const first = createUnrestrictedAgentState(true)
    const second = createUnrestrictedAgentState()
    first.shell = true

    expect(second.shell).toBe(false)
    expect(unrestrictedArgsForAgent('claude', first)).toEqual(['--dangerously-skip-permissions'])
    expect(unrestrictedArgsForAgent('shell', first)).toBeUndefined()
    expect(unrestrictedArgsForAgent('codex', second)).toBeUndefined()
  })
})
