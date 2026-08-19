import { describe, expect, it } from 'vitest'

import type { ProjectsState } from './projectsStore'
import { selectFirstWorkspaceTerminal } from './projectsStore'

function stateWith(
  containers: Array<{ projectId: string; paneIds: string[]; collapsed?: boolean }>,
  projects: Array<{
    id: string
    terminals: Array<{ id: string; disabled?: boolean; kind?: string }>
  }>,
): ProjectsState {
  return { workspace: { containers }, projects } as unknown as ProjectsState
}

describe('selectFirstWorkspaceTerminal', () => {
  it('returns the first pane of the first container', () => {
    const state = stateWith(
      [
        { projectId: 'p1', paneIds: ['t1', 't2'] },
        { projectId: 'p2', paneIds: ['t3'] },
      ],
      [
        { id: 'p1', terminals: [{ id: 't1' }, { id: 't2' }] },
        { id: 'p2', terminals: [{ id: 't3' }] },
      ],
    )

    expect(selectFirstWorkspaceTerminal(state)).toEqual({ projectId: 'p1', terminalId: 't1' })
  })

  it('skips collapsed containers, disabled terminals and non-terminal panes', () => {
    const state = stateWith(
      [
        { projectId: 'p1', paneIds: ['t1'], collapsed: true },
        { projectId: 'p2', paneIds: ['t2', 't3', 't4'] },
      ],
      [
        { id: 'p1', terminals: [{ id: 't1' }] },
        {
          id: 'p2',
          terminals: [
            { id: 't2', disabled: true },
            { id: 't3', kind: 'file' },
            { id: 't4', kind: 'terminal' },
          ],
        },
      ],
    )

    expect(selectFirstWorkspaceTerminal(state)).toEqual({ projectId: 'p2', terminalId: 't4' })
  })

  it('returns null when the workspace has no usable terminal', () => {
    expect(selectFirstWorkspaceTerminal(stateWith([], []))).toBeNull()
  })
})
