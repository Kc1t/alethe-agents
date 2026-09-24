import { describe, expect, it } from 'vitest'

import { terminalNameForPty } from './plannerLabel'
import type { Project } from './types'

function makeProjects(terminals: Array<{ name: string; tabs: Array<{ id: string; ptyId: string | null }> }>) {
  return [
    {
      id: 'p1',
      name: 'project',
      groupId: null,
      layoutMode: 'grid',
      terminals: terminals.map((terminal, index) => ({
        id: `t${index}`,
        name: terminal.name,
        cwd: 'C:\\proj',
        activeTabId: terminal.tabs[0]?.id ?? '',
        disabled: false,
        laneVisible: null,
        tabs: terminal.tabs.map((tab) => ({
          id: tab.id,
          type: 'claude',
          name: terminal.name,
          cwd: 'C:\\proj',
          ptyId: tab.ptyId,
        })),
      })),
    },
  ] as unknown as Project[]
}

describe('terminalNameForPty', () => {
  it("finds the terminal by a tab's real pty id", () => {
    const projects = makeProjects([{ name: 'planner-a', tabs: [{ id: 'tab-1', ptyId: 'pty-123' }] }])
    expect(terminalNameForPty(projects, 'pty-123')).toBe('planner-a')
  })

  it("falls back to matching a tab's own id, the stand-in used before a fresh spawn's pty id is known", () => {
    const projects = makeProjects([{ name: 'planner-b', tabs: [{ id: 'tab-2', ptyId: null }] }])
    expect(terminalNameForPty(projects, 'tab-2')).toBe('planner-b')
  })

  it('matches any tab on the terminal, not only its first one', () => {
    const projects = makeProjects([
      {
        name: 'multi-tab-planner',
        tabs: [
          { id: 'tab-a', ptyId: 'pty-a' },
          { id: 'tab-b', ptyId: 'pty-b' },
        ],
      },
    ])
    expect(terminalNameForPty(projects, 'pty-b')).toBe('multi-tab-planner')
  })

  it('returns undefined when nothing matches, instead of a raw id', () => {
    const projects = makeProjects([{ name: 'planner-c', tabs: [{ id: 'tab-4', ptyId: 'pty-4' }] }])
    expect(terminalNameForPty(projects, 'unknown-pty')).toBeUndefined()
  })

  it('searches across every project, not just the first', () => {
    const projects = [
      ...makeProjects([{ name: 'first-project-planner', tabs: [{ id: 'tab-a', ptyId: 'pty-a' }] }]),
      ...makeProjects([{ name: 'second-project-planner', tabs: [{ id: 'tab-b', ptyId: 'pty-b' }] }]),
    ]
    expect(terminalNameForPty(projects, 'pty-b')).toBe('second-project-planner')
  })
})
