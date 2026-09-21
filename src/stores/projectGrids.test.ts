import { beforeEach, describe, expect, it, vi } from 'vitest'

import { autoGridLayout } from '../lib/gridLayout'
import { DEFAULT_GRID_ID, gridTerminals } from '../lib/projectGrids'
import { cleanupPtys } from '../lib/terminalLifecycle'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from './projectsStore'
import { migrate } from './projectsStore.migrations'

vi.mock('../lib/terminalLifecycle', () => ({ cleanupPtys: vi.fn() }))

const store = () => useProjectsStore.getState()
const project = (id: string) => store().projects.find((item) => item.id === id)!
const createTerminal = (projectId: string, name: string, gridId?: string) =>
  store().createTerminal(projectId, {
    name,
    gridId,
    cwd: 'C:\\repo',
    firstTab: { type: 'shell', cwd: 'C:\\repo' },
  })

beforeEach(() => {
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  vi.clearAllMocks()
})

describe('named project grids', () => {
  it('migrates existing terminals and layout history to Default and survives a save/load round trip', () => {
    const p = store().createProject({ name: 'App' })
    const terminal = createTerminal(p.id, 'Shell')
    const layout = autoGridLayout([terminal.id], 3)
    const legacy = {
      ...project(p.id),
      grids: undefined,
      activeGridId: undefined,
      gridLayout: layout,
      layoutMode: 'grid',
      gridLayoutHistory: [{ id: 'layout', savedAt: 1, layout }],
      terminals: [{ ...terminal, gridId: undefined }],
    }
    const migrated = migrate({ ...EMPTY_PROJECTS_FILE, version: 8, projects: [legacy] })
    expect(migrated.version).toBe(9)
    expect(migrated.projects[0]).toMatchObject({
      activeGridId: undefined,
      grids: undefined,
      layoutMode: 'grid',
      gridLayout: layout,
      terminals: [{ id: terminal.id, gridId: undefined }],
    })
    expect(migrated.projects[0].gridLayoutHistory).toEqual(legacy.gridLayoutHistory)
    expect(migrate(JSON.parse(JSON.stringify(migrated))).projects).toEqual(migrated.projects)
  })

  it('opens empty grids, keeps one project tab, and restores grids through history and reopening', () => {
    const p = store().createProject({ name: 'App' })
    const original = createTerminal(p.id, 'Default shell')
    store().openProjectWorkspace(p.id)
    const tabId = store().workspace.activeTabId
    const backend = store().createProjectGrid(p.id, 'Backend')!
    expect(store().activeProjectId).toBe(p.id)
    expect(store().workspace.containers[0]).toMatchObject({ gridId: backend, paneIds: [] })
    const terminal = createTerminal(p.id, 'Backend shell')
    expect(project(p.id).terminals.find((item) => item.id === terminal.id)?.gridId).toBe(backend)
    expect(store().workspace.tabs).toHaveLength(1)
    expect(store().workspace.activeTabId).toBe(tabId)
    store().navigateWorkspaceHistory(-1)
    expect(store().workspace.containers[0].paneIds).toEqual([original.id])
    store().navigateWorkspaceHistory(1)
    expect(project(p.id).activeGridId).toBe(backend)
    expect(store().workspace.containers[0].paneIds).toEqual([terminal.id])
    store().openProjectWorkspace(p.id)
    expect(store().workspace.containers[0].gridId).toBe(backend)
    const restored = migrate(JSON.parse(JSON.stringify(store())))
    expect(restored.projects[0].activeGridId).toBe(backend)
    expect(restored.workspace.containers[0].paneIds).toEqual([terminal.id])
    expect(cleanupPtys).not.toHaveBeenCalled()
  })

  it('keeps layouts and their history independent', () => {
    const p = store().createProject({ name: 'App' })
    const a = createTerminal(p.id, 'A')
    store().openProjectWorkspace(p.id)
    const frontend = store().createProjectGrid(p.id, 'Frontend')!
    const firstLayout = autoGridLayout([a.id], 3)
    store().setProjectGridLayout(p.id, firstLayout, true)
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const b = createTerminal(p.id, 'B')
    const secondLayout = autoGridLayout([b.id], 1)
    store().setProjectGridLayout(p.id, secondLayout, true)
    store().openProjectGrid(p.id, frontend)
    expect(project(p.id).gridLayout).toEqual(firstLayout)
    expect(project(p.id).gridLayoutHistory).toHaveLength(1)
    store().openProjectGrid(p.id, backend)
    expect(project(p.id).gridLayout).toEqual(secondLayout)
    expect(project(p.id).gridLayoutHistory).toHaveLength(1)
  })

  it('moves related panes without changing session identifiers and preserves explicit compositions', () => {
    const p = store().createProject({ name: 'App' })
    const a = createTerminal(p.id, 'A')
    const b = createTerminal(p.id, 'B')
    store().setSubTabPtyId(p.id, a.id, a.activeTabId, 'running-pty')
    store().groupPanes(p.id, [a.id, b.id])
    store().openProjectWorkspace(p.id)
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const c = createTerminal(p.id, 'C')
    store().addTerminalToWorkspace(p.id, a.id)
    expect(store().workspace.containers[0].gridId).toBeUndefined()
    store().moveTerminalToGrid(p.id, a.id, backend)
    expect(gridTerminals(project(p.id), backend).map((item) => item.id)).toEqual([a.id, b.id, c.id])
    expect(store().workspace.containers[0].paneIds).toEqual([c.id, a.id])
    expect(project(p.id).terminals[0].tabs[0].ptyId).toBe('running-pty')
    expect(cleanupPtys).not.toHaveBeenCalled()
  })

  it('preserves terminals or deletes them using the existing cleanup flow and removes stale grid references', async () => {
    const p = store().createProject({ name: 'App' })
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const a = createTerminal(p.id, 'A')
    store().setSubTabPtyId(p.id, a.id, a.activeTabId, 'running-pty')
    await store().deleteProjectGrid(p.id, backend, 'move')
    expect(project(p.id).terminals[0]).toMatchObject({ id: a.id, gridId: undefined })
    expect(cleanupPtys).not.toHaveBeenCalled()
    expect(JSON.stringify(store().workspace)).not.toContain(backend)
    const second = store().createProjectGrid(p.id, 'Second')!
    store().moveTerminalToGrid(p.id, a.id, second)
    await store().deleteProjectGrid(p.id, second, 'delete')
    expect(project(p.id).terminals).toEqual([])
    expect(cleanupPtys).toHaveBeenCalledWith(['running-pty'])
    expect(JSON.stringify(store().workspace)).not.toContain(second)
    expect(project(p.id).activeGridId).toBeUndefined()
  })

  it('validates names and protects Default', async () => {
    const p = store().createProject({ name: 'App' })
    expect(store().createProjectGrid(p.id, ' ')).toBeNull()
    const backend = store().createProjectGrid(p.id, 'Backend')!
    expect(store().createProjectGrid(p.id, ' backend ')).toBeNull()
    expect(store().createProjectGrid(p.id, 'Default')).toBeNull()
    expect(store().renameProjectGrid(p.id, backend, 'API')).toBe(true)
    expect(store().renameProjectGrid(p.id, DEFAULT_GRID_ID, 'Other')).toBe(false)
    await store().deleteProjectGrid(p.id, DEFAULT_GRID_ID, 'delete')
    expect(project(p.id).grids).toHaveLength(1)
  })

  it('does not insert a delayed terminal into a different grid after navigating away', () => {
    const p = store().createProject({ name: 'App' })
    const backend = store().createProjectGrid(p.id, 'Backend')!
    store().createProjectGrid(p.id, 'Frontend')
    const delayed = createTerminal(p.id, 'Delayed', backend)
    expect(store().workspace.containers[0].paneIds).toEqual([])
    store().openProjectGrid(p.id, backend)
    expect(store().workspace.containers[0].paneIds).toEqual([delayed.id])
  })

  it('keeps the project tab and selected grid after deleting its last terminal', () => {
    const p = store().createProject({ name: 'App' })
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const terminal = createTerminal(p.id, 'Shell')
    const tabId = store().workspace.activeTabId
    store().deleteTerminal(p.id, terminal.id)
    expect(store().workspace.containers[0]).toMatchObject({ gridId: backend, paneIds: [] })
    expect(store().workspace.tabs[0]).toMatchObject({ id: tabId, kind: 'project' })
    store().openProjectWorkspace(p.id)
    expect(store().workspace.tabs).toHaveLength(1)
    expect(project(p.id).activeGridId).toBe(backend)
  })

  it('opens a group using the latest selected grid of each project', () => {
    const group = store().createGroup('Work')
    const p = store().createProject({ name: 'App', groupId: group.id })
    const original = createTerminal(p.id, 'Default shell')
    store().openGroupWorkspace(group.id, 'only')
    expect(store().workspace.containers[0].paneIds).toEqual([original.id])
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const terminal = createTerminal(p.id, 'Backend shell')
    store().openGroupWorkspace(group.id, 'only')
    expect(store().workspace.containers[0]).toMatchObject({
      gridId: backend,
      paneIds: [terminal.id],
    })
  })

  it('keeps worktree viewers with their owner and leaves Agent Sandbox projects unchanged', () => {
    const p = store().createProject({ name: 'App' })
    const backend = store().createProjectGrid(p.id, 'Backend')!
    const owner = store().createTerminal(p.id, {
      name: 'Owner',
      cwd: 'C:\\worktree',
      worktreeAgentId: 'agent',
      firstTab: { type: 'shell', cwd: 'C:\\worktree' },
    })
    store().createProjectGrid(p.id, 'Frontend')
    const viewer = store().createTerminal(p.id, {
      name: 'Viewer',
      cwd: 'C:\\worktree',
      gsdSyncViewer: true,
      firstTab: { type: 'shell', cwd: 'C:\\worktree' },
    })
    expect(project(p.id).terminals.find((item) => item.id === viewer.id)?.gridId).toBe(backend)
    store().moveTerminalToGrid(p.id, owner.id, DEFAULT_GRID_ID)
    expect(project(p.id).terminals.every((item) => item.gridId === undefined)).toBe(true)
    const sandbox = store().createProject({ name: 'Sandbox', mode: 'agentSandbox' })
    expect(sandbox.grids).toBeUndefined()
    expect(store().createProjectGrid(sandbox.id, 'Backend')).toBeNull()
  })
})
