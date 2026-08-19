/** Workspace and navigation actions extracted from the main store. */

import { nanoid } from 'nanoid'

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
  MAX_WORKSPACE_TABS,
  captureWorkspaceSnapshot,
  cloneWorkspaceSnapshot,
  compositionLabel,
  replaceCurrentHistorySnapshot,
  sanitizeWorkspaceSnapshot,
} from '../lib/workspaceNavigation'
import { collectGroupProjectIds } from './projectsStore.migrations'
import type { ProjectsState } from './projectsStore'
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
          : [
              ...state.workspace.containers,
              newContainer(
                id,
                target.terminals.map((t) => t.id),
                target.layoutMode,
              ),
            ]
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
            containers.push(
              newContainer(
                project.id,
                project.terminals.map((t) => t.id),
                project.layoutMode,
              ),
            )
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

    openProjectWorkspace: (projectId) =>
      navigationUpdate((state) => {
        const existing = state.workspace.tabs.find(
          (tab) => tab.kind === 'project' && tab.sourceId === projectId,
        )
        if (existing) return applyTabNavigation(state, existing)
        const project = state.projects.find((item) => item.id === projectId)
        if (!project) return
        const snapshot = makeSnapshot(
          state,
          project.terminals.length > 0
            ? [
                newContainer(
                  project.id,
                  project.terminals.map((terminal) => terminal.id),
                  project.layoutMode,
                ),
              ]
            : [],
          project.id,
          null,
          null,
          { workspaceGridLayout: undefined, workspaceFlat: false, fullscreenContainerId: null },
        )
        const now = Date.now()
        const tab: WorkspaceTab = {
          id: nanoid(),
          kind: 'project',
          sourceId: project.id,
          label: project.name,
          color: project.color,
          iconUrl: project.iconUrl,
          snapshot,
          createdAt: now,
          updatedAt: now,
        }
        return applyTabNavigation(state, tab, { addTab: true })
      }),

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
          makeSnapshot(
            state,
            [
              newContainer(
                project.id,
                project.terminals.map((terminal) => terminal.id),
                project.layoutMode,
              ),
            ],
            project.id,
            null,
          ),
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
              containers.push(
                newContainer(
                  project.id,
                  project.terminals.map((t) => t.id),
                  project.layoutMode,
                ),
              )
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
        if (existing) return applyTabNavigation(state, existing)
        const group = state.groups.find((item) => item.id === groupId)
        if (!group) return
        const projectIds = collectGroupProjectIds(groupId, state.groups)
        const scopedProjects = state.projects.filter(
          (project) => projectIds.has(project.id) && project.terminals.length > 0,
        )
        const containers = scopedProjects.map((project) =>
          newContainer(
            project.id,
            project.terminals.map((terminal) => terminal.id),
            project.layoutMode,
          ),
        )
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

    focusWorkspaceTerminal: (projectId, terminalId) =>
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
      }),

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
