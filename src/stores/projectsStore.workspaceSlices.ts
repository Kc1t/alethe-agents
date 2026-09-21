/** Workspace and navigation actions extracted from the main store. */
import { nanoid } from 'nanoid'

import { translate } from '../lib/i18n'
import {
  activeProjectGrid,
  DEFAULT_GRID_ID,
  gridTerminals,
  normalizeProjectGrids,
  projectGridContainer,
  projectGrids,
  relatedGridPaneIds,
  selectProjectGrid,
} from '../lib/projectGrids'
import {
  newContainer,
  rememberProjectTab,
  rememberWorkspaceTab,
  touchTerminalUsage,
} from '../lib/terminalFactory'
import type {
  GridLayout,
  GridLayoutHistoryEntry,
  Preferences,
  WorkspaceContainer,
  WorkspaceTab,
  WorkspaceViewSnapshot,
} from '../lib/types'

const MAX_GRID_LAYOUT_HISTORY = 8

function layoutsMatch(left: GridLayout, right: GridLayout): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function rememberGridLayout(
  history: GridLayoutHistoryEntry[] | undefined,
  layout: GridLayout,
): GridLayoutHistoryEntry[] {
  const current = history ?? []
  if (current[0] && layoutsMatch(current[0].layout, layout)) return current
  return [{ id: nanoid(), savedAt: Date.now(), layout: structuredClone(layout) }, ...current].slice(
    0,
    MAX_GRID_LAYOUT_HISTORY,
  )
}
import {
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  compositionLabel,
  MAX_WORKSPACE_TABS,
  replaceCurrentHistorySnapshot,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import type { ProjectsState } from './projectsStore'
import { collectGroupProjectIds } from './projectsStore.migrations'
import type { SliceCtx } from './projectsStore.slices'

type WorkspaceSliceCtx = SliceCtx & {
  navigationUpdate: (mutator: (state: ProjectsState) => Partial<ProjectsState> | void) => void
  makeSnapshot: (
    state: ProjectsState,
    containers: WorkspaceContainer[],
    activeProjectId: string | null,
    activeGroupId: string | null,
    focusedTerminalId?: string | null,
    visual?: Partial<
      Pick<Preferences, 'workspaceFlat' | 'fullscreenContainerId' | 'workspaceGridLayout'>
    >,
  ) => WorkspaceViewSnapshot
  applyTabNavigation: (
    state: ProjectsState,
    tab: WorkspaceTab,
    options?: { addTab?: boolean; pushHistory?: boolean },
  ) => Partial<ProjectsState>
  appendSnapshotToActive: (
    state: ProjectsState,
    incomingSnapshot: WorkspaceViewSnapshot,
  ) => Partial<ProjectsState> | undefined
}

type WorkspaceSlice = Pick<
  ProjectsState,
  | 'createProjectGrid'
  | 'renameProjectGrid'
  | 'toggleProjectGridCollapsed'
  | 'openProjectGrid'
  | 'moveTerminalToGrid'
  | 'deleteProjectGrid'
  | 'setActiveProject'
  | 'setActiveProjectOnly'
  | 'rememberWorkspaceGroupTab'
  | 'closeWorkspaceTab'
  | 'openGroupScope'
  | 'openProjectWorkspace'
  | 'addProjectToWorkspace'
  | 'openGroupWorkspace'
  | 'openTerminalWorkspace'
  | 'addTerminalToWorkspace'
  | 'addWorkspaceTabToCurrent'
  | 'focusWorkspaceTerminal'
  | 'activateWorkspaceTab'
  | 'toggleWorkspaceTabPinned'
  | 'closeSavedWorkspaceTab'
  | 'reopenClosedWorkspaceTab'
  | 'navigateWorkspaceHistory'
  | 'toggleProjectCollapsed'
  | 'setLayoutMode'
  | 'setProjectGridLayout'
  | 'setGroupLayoutMode'
  | 'setGroupGridLayout'
  | 'setWorkspaceGridLayout'
>

export function createWorkspaceSlice({
  get,
  update,
  updateProject,
  updateContainer,
  navigationUpdate,
  makeSnapshot,
  applyTabNavigation,
  appendSnapshotToActive,
}: WorkspaceSliceCtx): WorkspaceSlice {
  return {
    setActiveProject: (id) =>
      update((state) => {
        if (!id) return { activeProjectId: null }
        const target = state.projects.find((p) => p.id === id)
        if (!target) return { activeProjectId: id }
        const now = Date.now()

        const existing = state.workspace.containers.find((c) => c.projectId === id)
        if (target.terminals.length === 0) {
          return {
            activeProjectId: id,
            workspace: {
              ...state.workspace,
              recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'project',
                id,
              }),
            },
          }
        }
        const containers = existing
          ? state.workspace.containers.map((c) =>
              c.projectId === id ? { ...c, lastUsedAt: now, collapsed: false } : c,
            )
          : [...state.workspace.containers, projectGridContainer(target)]
        return {
          activeProjectId: id,
          workspace: {
            ...state.workspace,
            containers,
            recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'project',
              id,
            }),
          },
        }
      }),

    setActiveProjectOnly: (id) =>
      update((state) => {
        if (state.activeProjectId === id) return
        return {
          activeProjectId: id,
          workspace: id
            ? {
                ...state.workspace,
                recentProjectIds: rememberProjectTab(state.workspace.recentProjectIds, id),
                recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                  kind: 'project',
                  id,
                }),
              }
            : state.workspace,
        }
      }),

    rememberWorkspaceGroupTab: (groupId) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
            kind: 'group',
            id: groupId,
          }),
        },
      })),

    closeWorkspaceTab: (tab) =>
      update((state) => ({
        workspace: {
          ...state.workspace,
          recentProjectIds:
            tab.kind === 'project'
              ? (state.workspace.recentProjectIds ?? []).filter((id) => id !== tab.id)
              : state.workspace.recentProjectIds,
          recentTabs: (state.workspace.recentTabs ?? []).filter(
            (item) => !(item.kind === tab.kind && item.id === tab.id),
          ),
        },
      })),

    openGroupScope: (groupId, mode = 'append') =>
      update((state) => {
        const projectIds = collectGroupProjectIds(groupId, state.groups)
        const projectsInScope = state.projects.filter((p) => projectIds.has(p.id))
        const openableProjects = projectsInScope.filter((p) => p.terminals.length > 0)
        if (openableProjects.length === 0) {
          return {
            activeProjectId: projectsInScope[0]?.id ?? state.activeProjectId,
            workspace: {
              ...state.workspace,
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'group',
                id: groupId,
              }),
            },
          }
        }

        const containers = [...state.workspace.containers]
        for (const project of openableProjects) {
          const existingIndex = containers.findIndex((c) => c.projectId === project.id)
          if (existingIndex === -1) {
            containers.push(projectGridContainer(project))
          }
        }
        const nextContainers =
          mode === 'only' ? containers.filter((c) => projectIds.has(c.projectId)) : containers

        return {
          activeProjectId: openableProjects[0].id,
          workspace: {
            ...state.workspace,
            containers: nextContainers,
            recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
              kind: 'group',
              id: groupId,
            }),
          },
        }
      }),

    openProjectWorkspace: (projectId) => {
      const project = get().projects.find((item) => item.id === projectId)
      if (project) get().openProjectGrid(projectId, activeProjectGrid(project).id)
    },

    openProjectGrid: (projectId, gridId) =>
      navigationUpdate((state) => {
        const original = state.projects.find((item) => item.id === projectId)
        if (!original || !projectGrids(original).some((grid) => grid.id === gridId)) return
        const project = selectProjectGrid(normalizeProjectGrids(original), gridId)
        const projects = state.projects.map((item) => (item.id === projectId ? project : item))
        const base = { ...state, projects }
        const existing = state.workspace.tabs.find(
          (tab) => tab.kind === 'project' && tab.sourceId === projectId,
        )
        const snapshot = makeSnapshot(
          base,
          [projectGridContainer(project, gridId)],
          projectId,
          null,
          null,
          { workspaceGridLayout: undefined, workspaceFlat: false, fullscreenContainerId: null },
        )
        const now = Date.now()
        const tab: WorkspaceTab = {
          ...existing,
          id: existing?.id ?? nanoid(),
          kind: 'project',
          sourceId: projectId,
          label: project.name,
          color: project.color,
          iconUrl: project.iconUrl,
          snapshot,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }
        return { ...applyTabNavigation(base, tab, { addTab: true }), projects }
      }),

    createProjectGrid: (projectId, rawName) => {
      const project = get().projects.find((item) => item.id === projectId)
      const name = rawName.trim()
      if (!project || project.mode === 'agentSandbox' || !validGridName(project, name)) return null
      const id = nanoid()
      updateProject(projectId, (item) => ({
        ...item,
        collapsed: false,
        grids: [...(item.grids ?? []), { id, name, collapsed: false, layoutMode: 'auto' }],
      }))
      get().openProjectGrid(projectId, id)
      return id
    },

    renameProjectGrid: (projectId, gridId, rawName) => {
      const project = get().projects.find((item) => item.id === projectId)
      const name = rawName.trim()
      if (!project || gridId === DEFAULT_GRID_ID || !validGridName(project, name, gridId))
        return false
      if (!projectGrids(project).some((grid) => grid.id === gridId)) return false
      updateProject(projectId, (item) => ({
        ...item,
        grids: projectGrids(item).map((grid) => (grid.id === gridId ? { ...grid, name } : grid)),
      }))
      return true
    },

    toggleProjectGridCollapsed: (projectId, gridId) =>
      updateProject(projectId, (project) => ({
        ...project,
        grids: projectGrids(project).map((grid) =>
          grid.id === gridId ? { ...grid, collapsed: !grid.collapsed } : grid,
        ),
      })),

    moveTerminalToGrid: (projectId, terminalId, gridId) =>
      navigationUpdate((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (
          !project ||
          (gridId !== DEFAULT_GRID_ID &&
            !projectGrids(project).some((grid) => grid.id === gridId))
        )
          return
        const ids = relatedGridPaneIds(project, terminalId)
        const projects = state.projects.map((item) =>
          item.id !== projectId
            ? item
            : {
                ...item,
                terminals: item.terminals.map((terminal) =>
                  ids.has(terminal.id)
                    ? { ...terminal, gridId: gridId === DEFAULT_GRID_ID ? undefined : gridId }
                    : terminal,
                ),
              },
        )
        return { projects, workspace: refreshGridMembership(state, projects, projectId) }
      }),

    deleteProjectGrid: async (projectId, gridId, mode) => {
      const project = get().projects.find((item) => item.id === projectId)
      if (
        !project ||
        gridId === DEFAULT_GRID_ID ||
        !projectGrids(project).some((grid) => grid.id === gridId)
      )
        return
      if (mode === 'delete') {
        for (const terminal of gridTerminals(project, gridId)) {
          await get().deleteTerminalWithWorktreeCleanup(projectId, terminal.id)
        }
      }
      navigationUpdate((state) => {
        const projects = state.projects.map((item) => {
          if (item.id !== projectId) return item
          const next = {
            ...item,
            grids: (item.grids ?? []).filter((grid) => grid.id !== gridId),
            terminals: item.terminals.map((terminal) =>
              terminal.gridId === gridId ? { ...terminal, gridId: undefined } : terminal,
            ),
          }
          return selectProjectGrid(
            next,
            item.activeGridId === gridId ? DEFAULT_GRID_ID : activeProjectGrid(next).id,
          )
        })
        return { projects, workspace: refreshGridMembership(state, projects, projectId) }
      })
    },

    addProjectToWorkspace: (projectId) => {
      if (!get().workspace.activeTabId) {
        get().openProjectWorkspace(projectId)
        return
      }
      navigationUpdate((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        if (!project) return
        return appendSnapshotToActive(
          state,
          makeSnapshot(state, [projectGridContainer(project)], project.id, null),
        )
      })
    },

    openGroupWorkspace: (groupId, mode = 'append') => {
      if (mode === 'append' && get().workspace.activeTabId) {
        navigationUpdate((state) => {
          const activeTab = state.workspace.tabs.find(
            (tab) => tab.id === state.workspace.activeTabId,
          )
          if (!activeTab) return
          const projectIds = collectGroupProjectIds(groupId, state.groups)
          const toAdd = state.projects.filter(
            (project) => projectIds.has(project.id) && project.terminals.length > 0,
          )
          if (toAdd.length === 0) return
          const containers = [...state.workspace.containers]
          for (const project of toAdd) {
            if (!containers.some((c) => c.projectId === project.id)) {
              containers.push(projectGridContainer(project))
            }
          }

          const snapshot = makeSnapshot(state, containers, toAdd[0].id, null, null, {
            workspaceGridLayout: undefined,
            workspaceFlat: false,
            fullscreenContainerId: null,
          })
          const updatedTab: WorkspaceTab = {
            ...activeTab,
            kind: 'composition',
            sourceId: undefined,
            sourceProjectId: undefined,
            label: compositionLabel(snapshot, state.projects),
            snapshot,
            updatedAt: Date.now(),
          }
          return {
            activeProjectId: toAdd[0].id,
            preferences: {
              ...state.preferences,
              workspaceGridLayout: undefined,
              workspaceFlat: false,
              fullscreenContainerId: null,
            },
            workspace: {
              ...state.workspace,
              containers,
              activeGroupId: null,
              tabs: state.workspace.tabs.map((tab) =>
                tab.id === updatedTab.id ? updatedTab : tab,
              ),
              history: replaceCurrentHistorySnapshot(
                state.workspace.history,
                state.workspace.historyIndex,
                updatedTab,
              ),
              recentTabs: rememberWorkspaceTab(state.workspace.recentTabs, {
                kind: 'group',
                id: groupId,
              }),
            },
          }
        })
        return
      }
      navigationUpdate((state) => {
        const existing = state.workspace.tabs.find(
          (tab) => tab.kind === 'group' && tab.sourceId === groupId,
        )
        if (existing)
          return applyTabNavigation(
            state,
            {
              ...existing,
              snapshot: {
                ...existing.snapshot,
                containers: existing.snapshot.containers.map((container) => {
                  const project = state.projects.find((item) => item.id === container.projectId)
                  return project ? { ...container, ...projectGridContainer(project) } : container
                }),
              },
            },
            { addTab: true },
          )
        const group = state.groups.find((item) => item.id === groupId)
        if (!group) return
        const projectIds = collectGroupProjectIds(groupId, state.groups)
        const scopedProjects = state.projects.filter(
          (project) => projectIds.has(project.id) && project.terminals.length > 0,
        )
        const containers = scopedProjects.map((project) => projectGridContainer(project))
        const snapshot = makeSnapshot(
          state,
          containers,
          scopedProjects[0]?.id ?? null,
          group.id,
          null,
          {
            workspaceGridLayout: group.gridLayout,
            workspaceFlat: false,
            fullscreenContainerId: null,
          },
        )
        const now = Date.now()
        const tab: WorkspaceTab = {
          id: nanoid(),
          kind: 'group',
          sourceId: group.id,
          label: group.name,
          color: group.color,
          iconUrl: group.iconUrl,
          snapshot,
          createdAt: now,
          updatedAt: now,
        }
        return applyTabNavigation(state, tab, { addTab: true })
      })
    },

    openTerminalWorkspace: (projectId, terminalId) =>
      navigationUpdate((state) => {
        const existing = state.workspace.tabs.find(
          (tab) =>
            tab.kind === 'terminal' &&
            tab.sourceId === terminalId &&
            tab.sourceProjectId === projectId,
        )
        const project = state.projects.find((item) => item.id === projectId)
        const terminal = project?.terminals.find((item) => item.id === terminalId)
        if (!project || !terminal) return
        const projects = state.projects.map((item) =>
          item.id !== projectId
            ? item
            : {
                ...item,
                terminals: item.terminals.map((tab) =>
                  tab.id === terminalId ? touchTerminalUsage(tab) : tab,
                ),
              },
        )
        if (existing) {
          const nextState = { ...state, projects } as ProjectsState
          return { projects, ...applyTabNavigation(nextState, existing) }
        }
        const snapshot = makeSnapshot(
          { ...state, projects } as ProjectsState,
          [newContainer(project.id, [terminal.id], project.layoutMode)],
          project.id,
          null,
          terminal.id,
          { workspaceGridLayout: undefined, workspaceFlat: false, fullscreenContainerId: null },
        )
        const now = Date.now()
        const tab: WorkspaceTab = {
          id: nanoid(),
          kind: 'terminal',
          sourceId: terminal.id,
          sourceProjectId: project.id,
          label: terminal.name,
          color: project.color,
          iconUrl: project.iconUrl,
          snapshot,
          createdAt: now,
          updatedAt: now,
        }
        return {
          projects,
          ...applyTabNavigation({ ...state, projects } as ProjectsState, tab, { addTab: true }),
        }
      }),

    addTerminalToWorkspace: (projectId, terminalId) => {
      if (!get().workspace.activeTabId) {
        get().openTerminalWorkspace(projectId, terminalId)
        return
      }
      navigationUpdate((state) => {
        const project = state.projects.find((item) => item.id === projectId)
        const terminal = project?.terminals.find((item) => item.id === terminalId)
        if (!project || !terminal) return
        const projects = state.projects.map((item) =>
          item.id !== projectId
            ? item
            : {
                ...item,
                terminals: item.terminals.map((tab) =>
                  tab.id === terminalId ? touchTerminalUsage(tab) : tab,
                ),
              },
        )
        return {
          projects,
          ...appendSnapshotToActive(
            { ...state, projects } as ProjectsState,
            makeSnapshot(
              { ...state, projects } as ProjectsState,
              [newContainer(project.id, [terminal.id], project.layoutMode)],
              project.id,
              null,
              terminal.id,
            ),
          ),
        }
      })
    },

    addWorkspaceTabToCurrent: (tabId) => {
      const current = get()
      if (!current.workspace.activeTabId) {
        get().activateWorkspaceTab(tabId)
        return
      }
      navigationUpdate((state) => {
        const tab = state.workspace.tabs.find((item) => item.id === tabId)
        if (!tab || tab.id === state.workspace.activeTabId) return
        return appendSnapshotToActive(state, tab.snapshot)
      })
    },

    focusWorkspaceTerminal: (projectId, terminalId) => {
      const project = get().projects.find((item) => item.id === projectId)
      const terminal = project?.terminals.find((item) => item.id === terminalId)
      const visible = get().workspace.containers.some(
        (container) => container.projectId === projectId && container.paneIds.includes(terminalId),
      )
      if (project && terminal && !visible)
        get().openProjectGrid(projectId, terminal.gridId ?? DEFAULT_GRID_ID)
      navigationUpdate((state) => {
        const container = state.workspace.containers.find(
          (item) => item.projectId === projectId && item.paneIds.includes(terminalId),
        )
        if (!container) return
        const activeTab = state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
        if (!activeTab) return { activeProjectId: projectId }
        const projects = state.projects.map((project) =>
          project.id !== projectId
            ? project
            : {
                ...project,
                terminals: project.terminals.map((terminal) =>
                  terminal.id === terminalId ? touchTerminalUsage(terminal) : terminal,
                ),
              },
        )
        const snapshot = makeSnapshot(
          { ...state, projects } as ProjectsState,
          state.workspace.containers,
          projectId,
          state.workspace.activeGroupId,
          terminalId,
        )
        const updatedTab = { ...activeTab, snapshot, updatedAt: Date.now() }
        return {
          activeProjectId: projectId,
          projects,
          workspace: {
            ...state.workspace,
            focusedTerminalId: terminalId,
            tabs: state.workspace.tabs.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)),
            history: replaceCurrentHistorySnapshot(
              state.workspace.history,
              state.workspace.historyIndex,
              updatedTab,
            ),
          },
        }
      })
    },

    activateWorkspaceTab: (tabId) =>
      navigationUpdate((state) => {
        const tab = state.workspace.tabs.find((item) => item.id === tabId)
        return tab ? applyTabNavigation(state, tab) : undefined
      }),

    toggleWorkspaceTabPinned: (tabId) =>
      navigationUpdate((state) => {
        if (!state.workspace.tabs.some((tab) => tab.id === tabId)) return
        const tabs = state.workspace.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, pinned: !tab.pinned, updatedAt: Date.now() } : tab,
        )

        const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)]
        return { workspace: { ...state.workspace, tabs: ordered } }
      }),

    closeSavedWorkspaceTab: (tabId) =>
      navigationUpdate((state) => {
        const index = state.workspace.tabs.findIndex((tab) => tab.id === tabId)
        if (index === -1) return
        const closedTabs = [
          state.workspace.tabs[index],
          ...(state.workspace.closedTabs ?? []).filter((tab) => tab.id !== tabId),
        ].slice(0, MAX_WORKSPACE_TABS)
        const tabs = state.workspace.tabs.filter((tab) => tab.id !== tabId)
        const history = state.workspace.history.filter((entry) => entry.tabId !== tabId)
        if (state.workspace.activeTabId !== tabId) {
          return {
            workspace: {
              ...state.workspace,
              tabs,
              closedTabs,
              history,
              historyIndex: Math.min(state.workspace.historyIndex, history.length - 1),
            },
          }
        }
        const nextTab = tabs[Math.min(index, tabs.length - 1)]
        if (!nextTab) {
          return {
            activeProjectId: null,
            workspace: {
              ...state.workspace,
              containers: [],
              tabs: [],
              closedTabs,
              activeTabId: null,
              activeGroupId: null,
              focusedTerminalId: null,
              history: [],
              historyIndex: -1,
            },
          }
        }
        const base = {
          ...state,
          workspace: {
            ...state.workspace,
            tabs,
            closedTabs,
            history,
            historyIndex: history.length - 1,
          },
        }
        return applyTabNavigation(base, nextTab)
      }),

    reopenClosedWorkspaceTab: () =>
      navigationUpdate((state) => {
        const closedTabs = state.workspace.closedTabs ?? []
        const tab = closedTabs[0]
        if (!tab) return
        const restored = sanitizeWorkspaceSnapshot(tab.snapshot, state.projects)
        const nextTab = { ...tab, snapshot: restored, updatedAt: Date.now() }
        const base = {
          ...state,
          workspace: {
            ...state.workspace,
            closedTabs: closedTabs.slice(1),
          },
        }
        return applyTabNavigation(base, nextTab, { addTab: true })
      }),

    navigateWorkspaceHistory: (direction) =>
      navigationUpdate((state) => {
        const targetIndex = state.workspace.historyIndex + direction
        if (targetIndex < 0 || targetIndex >= state.workspace.history.length) return
        const target = state.workspace.history[targetIndex]
        const tab = state.workspace.tabs.find((item) => item.id === target.tabId)
        if (!tab) return
        const snapshot = sanitizeWorkspaceSnapshot(target.snapshot, state.projects)
        return {
          activeProjectId: snapshot.activeProjectId,
          preferences: {
            ...state.preferences,
            workspaceFlat: snapshot.workspaceFlat,
            fullscreenContainerId: snapshot.fullscreenContainerId,
            workspaceGridLayout: snapshot.workspaceGridLayout,
          },
          workspace: {
            ...state.workspace,
            containers: cloneWorkspaceSnapshot(snapshot).containers,
            activeTabId: tab.id,
            activeGroupId: snapshot.activeGroupId,
            focusedTerminalId: snapshot.focusedTerminalId,
            historyIndex: targetIndex,
            tabs: state.workspace.tabs.map((item) =>
              item.id === tab.id ? { ...item, snapshot } : item,
            ),
          },
        }
      }),

    toggleProjectCollapsed: (id) => updateProject(id, (p) => ({ ...p, collapsed: !p.collapsed })),

    setLayoutMode: (projectId, layout) => {
      updateProject(projectId, (p) => ({ ...p, layoutMode: layout }))
      updateContainer(projectId, (c) => ({ ...c, internalLayout: layout }))
    },

    setProjectGridLayout: (projectId, layout, recordHistory = false) =>
      update((state) => ({
        projects: state.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                gridLayout: layout,
                layoutMode: 'grid',
                gridLayoutHistory: recordHistory
                  ? rememberGridLayout(p.gridLayoutHistory, layout)
                  : p.gridLayoutHistory,
              }
            : p,
        ),
        // Keep the open workspace container in sync so the new grid applies immediately.
        workspace: {
          ...state.workspace,
          containers: state.workspace.containers.map((c) =>
            c.projectId === projectId ? { ...c, internalLayout: 'grid' } : c,
          ),
        },
      })),

    setGroupLayoutMode: (groupId, mode) =>
      update((state) => ({
        groups: state.groups.map((g) => (g.id === groupId ? { ...g, layoutMode: mode } : g)),
      })),

    setGroupGridLayout: (groupId, layout, recordHistory = false) =>
      update((state) => ({
        groups: state.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                gridLayout: layout,
                layoutMode: 'grid',
                gridLayoutHistory: recordHistory
                  ? rememberGridLayout(g.gridLayoutHistory, layout)
                  : g.gridLayoutHistory,
              }
            : g,
        ),
      })),

    setWorkspaceGridLayout: (layout, recordHistory = false) =>
      update((state) => {
        const workspaceGridLayout = layout ?? undefined
        const preferences = {
          ...state.preferences,
          workspaceFlat: false,
          workspaceGridLayout,
          workspaceGridLayoutHistory:
            layout && recordHistory
              ? rememberGridLayout(state.preferences.workspaceGridLayoutHistory, layout)
              : state.preferences.workspaceGridLayoutHistory,
        }
        const activeTab = state.workspace.tabs.find((tab) => tab.id === state.workspace.activeTabId)
        if (!activeTab) return { preferences }

        const snapshot = captureWorkspaceSnapshot({
          containers: state.workspace.containers,
          activeProjectId: state.activeProjectId,
          activeGroupId: state.workspace.activeGroupId,
          focusedTerminalId: state.workspace.focusedTerminalId,
          preferences,
        })
        const updatedTab = { ...activeTab, snapshot, updatedAt: Date.now() }
        return {
          preferences,
          workspace: {
            ...state.workspace,
            tabs: state.workspace.tabs.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)),
            history: replaceCurrentHistorySnapshot(
              state.workspace.history,
              state.workspace.historyIndex,
              updatedTab,
            ),
          },
        }
      }),
  }
}

function validGridName(
  project: import('../lib/types').Project,
  name: string,
  exceptId?: string,
): boolean {
  const key = name.toLocaleLowerCase()
  return (
    Boolean(name) &&
    ![translate('en', 'projectGrid.default'), translate('pt-BR', 'projectGrid.default')].some(
      (label) => label.toLocaleLowerCase() === key,
    ) &&
    !projectGrids(project).some(
      (grid) => grid.id !== exceptId && grid.name.toLocaleLowerCase() === key,
    )
  )
}

function refreshGridMembership(
  state: ProjectsState,
  projects: ProjectsState['projects'],
  projectId: string,
): ProjectsState['workspace'] {
  const refresh = (snapshot: WorkspaceViewSnapshot) =>
    sanitizeWorkspaceSnapshot(
      {
        ...snapshot,
        containers: snapshot.containers.map((container) => {
          if (container.projectId !== projectId || !container.gridId) return container
          const project = projects.find((item) => item.id === projectId)!
          const gridId = projectGrids(project).some((grid) => grid.id === container.gridId)
            ? container.gridId
            : DEFAULT_GRID_ID
          if (gridId === DEFAULT_GRID_ID && !project.grids?.length) {
            return {
              ...container,
              gridId: undefined,
              paneIds: project.terminals.map((terminal) => terminal.id),
            }
          }
          return {
            ...container,
            gridId,
            paneIds: gridTerminals(project, gridId).map((terminal) => terminal.id),
          }
        }),
      },
      projects,
    )
  const live = refresh(
    captureWorkspaceSnapshot({
      containers: state.workspace.containers,
      activeProjectId: state.activeProjectId,
      activeGroupId: state.workspace.activeGroupId,
      focusedTerminalId: state.workspace.focusedTerminalId,
      preferences: state.preferences,
    }),
  )
  return {
    ...state.workspace,
    containers: live.containers,
    focusedTerminalId: live.focusedTerminalId,
    tabs: state.workspace.tabs.map((tab) => ({ ...tab, snapshot: refresh(tab.snapshot) })),
    closedTabs: state.workspace.closedTabs?.map((tab) => ({
      ...tab,
      snapshot: refresh(tab.snapshot),
    })),
    history: state.workspace.history.map((entry) => ({
      ...entry,
      snapshot: refresh(entry.snapshot),
    })),
  }
}
