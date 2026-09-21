import type { Project, ProjectGrid, Terminal, WorkspaceContainer } from './types'

export const DEFAULT_GRID_ID = 'default'

export function projectGrids(project: Project): ProjectGrid[] {
  return (
    project.grids ?? [
      {
        id: DEFAULT_GRID_ID,
        name: 'Default',
        collapsed: false,
        layoutMode: project.layoutMode,
        gridLayout: project.gridLayout,
        gridLayoutHistory: project.gridLayoutHistory,
      },
    ]
  )
}

/** A project has a visible grid only after the user creates one. */
export function hasCustomProjectGrids(project: Project): boolean {
  return Boolean(project.grids?.some((grid) => grid.id !== DEFAULT_GRID_ID))
}

export function activeProjectGrid(project: Project): ProjectGrid {
  const grids = projectGrids(project)
  return grids.find((grid) => grid.id === project.activeGridId) ?? grids[0]
}

export function gridTerminals(
  project: Project,
  gridId = activeProjectGrid(project).id,
): Terminal[] {
  return project.mode === 'agentSandbox'
    ? project.terminals
    : project.terminals.filter((terminal) => (terminal.gridId ?? DEFAULT_GRID_ID) === gridId)
}

/** The legacy layout fields expose the selected grid to existing layout controls. */
export function selectProjectGrid(project: Project, gridId: string): Project {
  const grid = projectGrids(project).find((item) => item.id === gridId)
  if (project.mode === 'agentSandbox') return project
  if (!grid)
    return gridId === DEFAULT_GRID_ID ? { ...project, activeGridId: undefined } : project
  return {
    ...project,
    activeGridId: grid.id,
    layoutMode: grid.layoutMode,
    gridLayout: grid.gridLayout,
    gridLayoutHistory: grid.gridLayoutHistory,
  }
}

export function normalizeProjectGrids(project: Project, previous?: Project): Project {
  if (project.mode === 'agentSandbox') return project
  const onlyDefaultGrid = project.grids?.length === 1 && project.grids[0]?.id === DEFAULT_GRID_ID
  if (onlyDefaultGrid) {
    return {
      ...project,
      grids: undefined,
      activeGridId: undefined,
      terminals: project.terminals.map((terminal) => ({ ...terminal, gridId: undefined })),
    }
  }
  let grids = project.grids?.filter((grid) => grid.id !== DEFAULT_GRID_ID) ?? []
  const activeGridId = grids.some((grid) => grid.id === project.activeGridId)
    ? project.activeGridId!
    : (grids[0]?.id ?? DEFAULT_GRID_ID)
  if (
    previous &&
    previous.activeGridId === activeGridId &&
    (previous.layoutMode !== project.layoutMode ||
      previous.gridLayout !== project.gridLayout ||
      previous.gridLayoutHistory !== project.gridLayoutHistory)
  ) {
    grids = grids.map((grid) =>
      grid.id === activeGridId
        ? {
            ...grid,
            layoutMode: project.layoutMode,
            gridLayout: project.gridLayout,
            gridLayoutHistory: project.gridLayoutHistory,
          }
        : grid,
    )
  }
  const previousIds = new Set(previous?.terminals.map((terminal) => terminal.id))
  const terminals = project.terminals.map((terminal) => {
    let gridId = terminal.gridId
    if (!gridId && previous && !previousIds.has(terminal.id) && project.grids?.length) {
      gridId = activeGridId
    }
    if (gridId && !grids.some((grid) => grid.id === gridId)) gridId = undefined
    if (terminal.gsdSyncViewer) {
      const owner = project.terminals.find(
        (item) => item.worktreeAgentId && item.cwd === terminal.cwd,
      )
      if (owner) gridId = owner.gridId
    }
    return terminal.gridId === gridId ? terminal : { ...terminal, gridId }
  })
  const normalized = { ...project, grids: project.grids ? grids : undefined, terminals }
  return project.grids?.length ? selectProjectGrid(normalized, activeGridId) : normalized
}

export function projectGridContainer(
  project: Project,
  gridId = activeProjectGrid(project).id,
): WorkspaceContainer {
  const grid =
    projectGrids(project).find((item) => item.id === gridId) ?? activeProjectGrid(project)
  return {
    projectId: project.id,
    gridId:
      project.mode === 'agentSandbox' || (grid.id === DEFAULT_GRID_ID && !project.grids?.length)
        ? undefined
        : grid.id,
    paneIds: gridTerminals(project, grid.id).map((terminal) => terminal.id),
    internalLayout: grid.layoutMode,
    collapsed: false,
    size: 0,
    lastUsedAt: Date.now(),
  }
}

/** Move inseparable pane blocks and their worktree viewers together. */
export function relatedGridPaneIds(project: Project, terminalId: string): Set<string> {
  const ids = new Set([terminalId])
  let size = 0
  while (size !== ids.size) {
    size = ids.size
    for (const group of project.paneGroups ?? []) {
      if (group.paneIds.some((id) => ids.has(id))) group.paneIds.forEach((id) => ids.add(id))
    }
    for (const owner of project.terminals) {
      if (!owner.worktreeAgentId) continue
      const viewers = project.terminals.filter(
        (item) => item.gsdSyncViewer && item.cwd === owner.cwd,
      )
      if (ids.has(owner.id) || viewers.some((item) => ids.has(item.id))) {
        ids.add(owner.id)
        viewers.forEach((item) => ids.add(item.id))
      }
    }
  }
  return ids
}
