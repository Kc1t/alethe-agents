import { DEFAULT_GRID_ID, gridTerminals, projectGrids } from './projectGrids'
import type {
  GridLayout,
  Preferences,
  Project,
  WorkspaceContainer,
  WorkspaceHistoryEntry,
  WorkspaceTab,
  WorkspaceViewSnapshot,
} from './types'

export const MAX_WORKSPACE_TABS = 10
export const MAX_WORKSPACE_HISTORY = 50

function cloneGrid(layout: GridLayout | undefined): GridLayout | undefined {
  if (!layout) return undefined
  return {
    ...layout,
    cells: Object.fromEntries(Object.entries(layout.cells).map(([id, cell]) => [id, { ...cell }])),
    colSizes: layout.colSizes ? [...layout.colSizes] : undefined,
    rowSizes: layout.rowSizes ? [...layout.rowSizes] : undefined,
  }
}

export function cloneContainers(containers: WorkspaceContainer[]): WorkspaceContainer[] {
  return containers.map((container) => ({
    ...container,
    paneIds: [...container.paneIds],
  }))
}

export function cloneWorkspaceSnapshot(snapshot: WorkspaceViewSnapshot): WorkspaceViewSnapshot {
  return {
    ...snapshot,
    containers: cloneContainers(snapshot.containers),
    workspaceGridLayout: cloneGrid(snapshot.workspaceGridLayout),
  }
}

export function captureWorkspaceSnapshot(args: {
  containers: WorkspaceContainer[]
  activeProjectId: string | null
  activeGroupId: string | null
  focusedTerminalId: string | null
  preferences: Preferences
}): WorkspaceViewSnapshot {
  return {
    containers: cloneContainers(args.containers),
    activeProjectId: args.activeProjectId,
    activeGroupId: args.activeGroupId,
    focusedTerminalId: args.focusedTerminalId,
    workspaceFlat: args.preferences.workspaceFlat,
    fullscreenContainerId: args.preferences.fullscreenContainerId,
    workspaceGridLayout: cloneGrid(args.preferences.workspaceGridLayout),
  }
}

export function sanitizeWorkspaceSnapshot(
  snapshot: WorkspaceViewSnapshot,
  projects: Project[],
): WorkspaceViewSnapshot {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const containers = snapshot.containers.flatMap((container) => {
    const project = projectsById.get(container.projectId)
    if (!project) return []
    if (container.gridId) {
      const gridId = projectGrids(project).some((grid) => grid.id === container.gridId)
        ? container.gridId : DEFAULT_GRID_ID
      const members = gridTerminals(project, gridId)
      const memberIds = new Set(members.map((terminal) => terminal.id))
      const grid = projectGrids(project).find((item) => item.id === gridId)!
      return [{ ...container, gridId, internalLayout: grid.layoutMode,
        paneIds: gridId === container.gridId ? container.paneIds.filter((id) => memberIds.has(id)) : members.map((item) => item.id),
      }]
    }
    const terminalIds = new Set(project.terminals.map((terminal) => terminal.id))
    const paneIds = container.paneIds.filter((id) => terminalIds.has(id))
    return paneIds.length > 0 ? [{ ...container, paneIds }] : []
  })
  const visibleTerminalIds = new Set(containers.flatMap((container) => container.paneIds))
  const visibleProjectIds = new Set(containers.map((container) => container.projectId))
  return {
    ...cloneWorkspaceSnapshot(snapshot),
    containers,
    activeProjectId:
      snapshot.activeProjectId && visibleProjectIds.has(snapshot.activeProjectId)
        ? snapshot.activeProjectId
        : (containers[0]?.projectId ?? null),
    focusedTerminalId:
      snapshot.focusedTerminalId && visibleTerminalIds.has(snapshot.focusedTerminalId)
        ? snapshot.focusedTerminalId
        : null,
    fullscreenContainerId:
      snapshot.fullscreenContainerId && visibleProjectIds.has(snapshot.fullscreenContainerId)
        ? snapshot.fullscreenContainerId
        : null,
  }
}

export function compositionLabel(snapshot: WorkspaceViewSnapshot, projects: Project[]): string {
  const names = snapshot.containers
    .map((container) => projects.find((project) => project.id === container.projectId)?.name)
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return 'Workspace'
  if (names.length === 1) {
    const paneCount = snapshot.containers[0]?.paneIds.length ?? 0
    return paneCount > 1 ? `${names[0]} + ${paneCount - 1}` : names[0]
  }
  return `${names[0]} + ${names.length - 1}`
}

export function pushWorkspaceHistory(
  history: WorkspaceHistoryEntry[],
  historyIndex: number,
  entry: WorkspaceHistoryEntry,
): { history: WorkspaceHistoryEntry[]; historyIndex: number } {
  const branch = history.slice(0, historyIndex + 1)
  const next = [...branch, { ...entry, snapshot: cloneWorkspaceSnapshot(entry.snapshot) }].slice(
    -MAX_WORKSPACE_HISTORY,
  )
  return { history: next, historyIndex: next.length - 1 }
}

export function replaceCurrentHistorySnapshot(
  history: WorkspaceHistoryEntry[],
  historyIndex: number,
  tab: WorkspaceTab,
): WorkspaceHistoryEntry[] {
  if (historyIndex < 0 || historyIndex >= history.length) return history
  return history.map((entry, index) =>
    index === historyIndex
      ? {
          ...entry,
          tabId: tab.id,
          label: tab.label,
          snapshot: cloneWorkspaceSnapshot(tab.snapshot),
        }
      : entry,
  )
}
