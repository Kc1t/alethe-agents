import { nanoid } from 'nanoid'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { makeDefaultTerminal, newContainer } from '../lib/terminalFactory'
import type { Group, Project, WorkspaceTab } from '../lib/types'
import { useProjectsStore } from './projectsStore'

// The topbar's pinned/recent tab strip snapshots a WorkspaceTab.label once, at creation time.
// Renaming the underlying terminal/project/group has to be pushed into any matching tab
// explicitly, or the strip keeps showing the stale name even though the workspace itself
// reflects the rename. These are regression tests for that sync.

function emptySnapshot(projectId: string | null) {
  return {
    containers: [],
    activeProjectId: projectId,
    activeGroupId: null,
    focusedTerminalId: null,
    workspaceFlat: false,
    fullscreenContainerId: null,
  }
}

describe('workspace tab label sync on rename', () => {
  let restore: { projects: ReturnType<typeof useProjectsStore.getState>['projects'] }

  beforeEach(() => {
    const state = useProjectsStore.getState()
    restore = { projects: state.projects }
  })

  afterEach(() => {
    // Only the fields these tests touch need restoring — everything else in the singleton
    // store is left untouched.
    useProjectsStore.setState({
      projects: restore.projects,
      groups: [],
      workspace: {
        ...useProjectsStore.getState().workspace,
        containers: [],
        tabs: [],
        activeTabId: null,
        activeGroupId: null,
        history: [],
        historyIndex: -1,
      },
    })
  })

  it('renameTerminal updates the label of the matching terminal tab, even when it is active', () => {
    const projectId = nanoid()
    const terminal = makeDefaultTerminal({
      name: 'old name',
      cwd: '/tmp',
      firstTab: { type: 'shell', cwd: '/tmp' },
    })
    const project: Project = {
      id: projectId,
      name: 'My Project',
      groupId: null,
      terminals: [terminal],
      layoutMode: 'auto',
      collapsed: false,
      createdAt: Date.now(),
    }
    const tab: WorkspaceTab = {
      id: nanoid(),
      kind: 'terminal',
      sourceId: terminal.id,
      sourceProjectId: projectId,
      label: 'old name',
      snapshot: emptySnapshot(projectId),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useProjectsStore.setState({
      projects: [project],
      workspace: {
        ...useProjectsStore.getState().workspace,
        containers: [newContainer(projectId, [terminal.id], 'auto')],
        tabs: [tab],
        activeTabId: tab.id,
        activeGroupId: null,
      },
    })

    useProjectsStore.getState().renameTerminal(projectId, terminal.id, 'tests')

    const updatedTab = useProjectsStore.getState().workspace.tabs.find((t) => t.id === tab.id)
    expect(updatedTab?.label).toBe('tests')
    expect(updatedTab?.kind).toBe('terminal')
    expect(updatedTab?.sourceId).toBe(terminal.id)
    expect(updatedTab?.sourceProjectId).toBe(projectId)
  })

  it('renameProject updates the label of the matching project tab', () => {
    const projectId = nanoid()
    const project: Project = {
      id: projectId,
      name: 'old name',
      groupId: null,
      terminals: [],
      layoutMode: 'auto',
      collapsed: false,
      createdAt: Date.now(),
    }
    const tab: WorkspaceTab = {
      id: nanoid(),
      kind: 'project',
      sourceId: projectId,
      label: 'old name',
      snapshot: emptySnapshot(projectId),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useProjectsStore.setState({
      projects: [project],
      workspace: {
        ...useProjectsStore.getState().workspace,
        tabs: [tab],
        activeTabId: tab.id,
        activeGroupId: null,
      },
    })

    useProjectsStore.getState().renameProject(projectId, 'tests')

    const updatedTab = useProjectsStore.getState().workspace.tabs.find((t) => t.id === tab.id)
    expect(updatedTab?.label).toBe('tests')
  })

  it('renameGroup updates the label of the matching group tab', () => {
    const groupId = nanoid()
    const group: Group = {
      id: groupId,
      name: 'old name',
      color: '#6ea8ff',
      parentGroupId: null,
      projectIds: [],
      collapsed: false,
    }
    const tab: WorkspaceTab = {
      id: nanoid(),
      kind: 'group',
      sourceId: groupId,
      label: 'old name',
      snapshot: emptySnapshot(null),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    useProjectsStore.setState({
      groups: [group],
      workspace: {
        ...useProjectsStore.getState().workspace,
        tabs: [tab],
        activeTabId: tab.id,
        activeGroupId: null,
      },
    })

    useProjectsStore.getState().renameGroup(groupId, 'tests')

    const updatedTab = useProjectsStore.getState().workspace.tabs.find((t) => t.id === tab.id)
    expect(updatedTab?.label).toBe('tests')
  })
})
