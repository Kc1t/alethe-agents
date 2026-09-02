import { describe, expect, it } from 'vitest'

import { resolveAgentPromptTargets } from './changeTriggerTargets'
import type { Project } from './types'

function project(terminals: unknown[]): Project {
  return { id: 'p1', name: 'Project', terminals } as unknown as Project
}

describe('agent prompt targets', () => {
  it('ignores a tab whose process is no longer running', () => {
    // Writing to a dead PTY loses the prompt silently — the user sees nothing sent and nothing
    // failed, which is the worst of both.
    const targets = resolveAgentPromptTargets(
      project([
        { id: 't1', name: 'Dead', lastUsedAt: 5, tabs: [{ id: 'a', type: 'claude', ptyId: null }] },
        { id: 't2', name: 'Live', lastUsedAt: 5, tabs: [{ id: 'b', type: 'claude', ptyId: 'pty-b' }] },
      ]),
    )

    expect(targets.map((target) => target.terminalId)).toEqual(['t2'])
  })

  it('excludes shell tabs', () => {
    // A shell would take the prompt as a command line and fail on the first word.
    const targets = resolveAgentPromptTargets(
      project([
        { id: 't1', name: 'Shell', lastUsedAt: 9, tabs: [{ id: 'a', type: 'shell', ptyId: 'pty-a' }] },
        { id: 't2', name: 'Codex', lastUsedAt: 1, tabs: [{ id: 'b', type: 'codex', ptyId: 'pty-b' }] },
      ]),
    )

    expect(targets.map((target) => target.agentType)).toEqual(['codex'])
  })

  it('puts the most recently used conversation first', () => {
    // The app cannot know which agent the user means; the best available guess is the one they
    // were last talking to. It is a default, not a decision — the UI still offers the others.
    const targets = resolveAgentPromptTargets(
      project([
        { id: 't1', name: 'Old', lastUsedAt: 1, tabs: [{ id: 'a', type: 'claude', ptyId: 'pty-a', lastUsedAt: 1 }] },
        { id: 't2', name: 'Recent', lastUsedAt: 1, tabs: [{ id: 'b', type: 'codex', ptyId: 'pty-b', lastUsedAt: 99 }] },
      ]),
    )

    expect(targets.map((target) => target.terminalName)).toEqual(['Recent', 'Old'])
  })

  it('returns nothing for a project with no agent running', () => {
    expect(resolveAgentPromptTargets(undefined)).toEqual([])
    expect(resolveAgentPromptTargets(project([]))).toEqual([])
  })
})
