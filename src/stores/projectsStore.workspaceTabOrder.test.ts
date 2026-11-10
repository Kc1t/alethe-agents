import { nanoid } from 'nanoid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeDefaultTerminal } from '../lib/terminalFactory'
import type { Project } from '../lib/types'
import { useProjectsStore } from './projectsStore'

function project(name: string): Project {
  return {
    id: nanoid(),
    name,
    groupId: null,
    terminals: [
      makeDefaultTerminal({ name: 'shell', cwd: '/tmp', firstTab: { type: 'shell', cwd: '/tmp' } }),
    ],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: Date.now(),
  }
}

const labels = () => useProjectsStore.getState().workspace.tabs.map((tab) => tab.label)

describe('workspace tab order', () => {
  let restore: ReturnType<typeof useProjectsStore.getState>

  beforeEach(() => {
    restore = useProjectsStore.getState()
    const projects = ['alpha', 'beta', 'gamma'].map(project)
    useProjectsStore.setState({
      projects,
      groups: [],
      workspace: {
        ...restore.workspace,
        containers: [],
        tabs: [],
        activeTabId: null,
        activeGroupId: null,
        history: [],
        historyIndex: -1,
      },
    })
    for (const item of projects) useProjectsStore.getState().openProjectWorkspace(item.id)
  })

  afterEach(() => {
    useProjectsStore.setState({
      projects: restore.projects,
      groups: restore.groups,
      workspace: restore.workspace,
    })
  })

  it('moves a tab to where it is dropped', () => {
    const gamma = useProjectsStore.getState().workspace.tabs[2]
    useProjectsStore.getState().moveWorkspaceTab(gamma.id, 0)
    expect(labels()).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('keeps the order when a project already in the bar is opened again', () => {
    const [alpha] = useProjectsStore.getState().projects
    useProjectsStore.getState().openProjectWorkspace(alpha.id)
    expect(labels()).toEqual(['alpha', 'beta', 'gamma'])
    expect(useProjectsStore.getState().workspace.activeTabId).toBe(
      useProjectsStore.getState().workspace.tabs[0].id,
    )
  })
})
