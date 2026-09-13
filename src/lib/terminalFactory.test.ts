import { describe, expect, it } from 'vitest'

import { sidebarTerminalDisplayName } from './terminalFactory'
import type { Terminal } from './types'

// A sidebar row prefers a live auto-derived title (Claude's session title, or the active
// sub-tab's agent-type name) over Terminal.name — but an explicit rename (customName) has to
// win over that, or it's silently shadowed forever. Regression coverage for that priority.

function terminalWith(overrides: Partial<Terminal>): Terminal {
  return {
    id: 't1',
    name: 'claude',
    cwd: '/tmp',
    activeTabId: 'tab1',
    disabled: false,
    laneVisible: null,
    tabs: [{ id: 'tab1', type: 'claude', name: 'claude', cwd: '/tmp', lastUsedAt: 0, ptyId: null }],
    ...overrides,
  }
}

describe('sidebarTerminalDisplayName', () => {
  it('prefers the live chat title when the terminal was never renamed', () => {
    const terminal = terminalWith({})
    expect(sidebarTerminalDisplayName(terminal, 'Fix the login bug')).toBe('Fix the login bug')
  })

  it('falls back to the active sub-tab name when there is no chat title', () => {
    const terminal = terminalWith({})
    expect(sidebarTerminalDisplayName(terminal, null)).toBe('claude')
  })

  it('falls back to the terminal name when there is no active sub-tab', () => {
    const terminal = terminalWith({ name: 'My Pane', tabs: [], activeTabId: 'missing' })
    expect(sidebarTerminalDisplayName(terminal, null)).toBe('My Pane')
  })

  it('an explicit rename wins over the chat title', () => {
    const terminal = terminalWith({ name: 'tests', customName: true })
    expect(sidebarTerminalDisplayName(terminal, 'Fix the login bug')).toBe('tests')
  })

  it('an explicit rename wins over the active sub-tab name', () => {
    const terminal = terminalWith({ name: 'tests', customName: true })
    expect(sidebarTerminalDisplayName(terminal, null)).toBe('tests')
  })
})
