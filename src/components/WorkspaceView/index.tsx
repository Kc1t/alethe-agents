import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { FolderOpen, FolderPlus, TerminalSquare } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Panel, Separator } from 'react-resizable-panels'
import { useShallow } from 'zustand/react/shallow'

import { pickDirectory } from '../../lib/dialog'
import { hasFileDragPayload, readFileDragPayload } from '../../lib/fileDrag'
import {
  cellStyle,
  freeCells,
  gridContainerStyle,
  moveCellTo,
  reconcileGridLayout,
} from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import type {
  AgentType,
  GridLayout,
  Group,
  Project,
  Terminal,
  WorkspaceContainer,
} from '../../lib/types'
import { MAX_WORKSPACE_TABS } from '../../lib/workspaceNavigation'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { GridCellHandles } from '../GridCellHandles'
import { AgentIcon } from '../icons/AgentIcons'
import { PaneArea } from './PaneArea'
import { PersistentPanelGroup as PanelGroup } from './PersistentPanelGroup'
import { ProjectContainer } from './ProjectContainer'
import { WorkspaceSurfaceProvider } from './workspaceSurface'
import styles from './WorkspaceView.module.css'

function resolveGroup(project: Project, groupsById: Map<string, Group>): Group | null {
  return project.groupId ? (groupsById.get(project.groupId) ?? null) : null
}

/*
 * Two tiers, because the two costs are different.
 *
 * MOUNTED: the tab keeps its React tree, so its xterm instances are never disposed and never
 * re-attach or replay their scrollback. This matches the number of tabs the tab bar holds — every
 * tab reachable with Ctrl+Tab stays mounted, or cycling through projects evicts them in a loop.
 * The cost is memory for the hidden terminals.
 *
 * STREAMING: on top of that, this many of the most recent hidden tabs keep receiving output from
 * their PTYs. Beyond them, hidden panes stop streaming and resync when they come back — a redraw,
 * not a restart. This bounds the IPC traffic of a large workspace.
 */
const MAX_LIVE_WORKSPACE_TABS = MAX_WORKSPACE_TABS
const MAX_STREAMING_BACKGROUND_TABS = 2

type WorkspaceSurface = {
  key: string
  tabId: string | null
  active: boolean
  containers: WorkspaceContainer[]
  activeGroupId: string | null
  flat: boolean
}

function collectGroupProjectIds(groupId: string, groups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [groupId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const group = groups.find((g) => g.id === current)
    if (!group) continue
    for (const projectId of group.projectIds) result.add(projectId)
    for (const child of groups) {
      if (child.parentGroupId === current) queue.push(child.id)
    }
  }
  return result
}

export function WorkspaceView() {
  const {
    allContainers,
    projects,
    groups,
    flat,
    fullscreenId,
    setFullscreenContainer,
    reorderPane,
    reorderContainers,
    setWorkspaceGridLayout,
    setGroupGridLayout,
    setProjectGridLayout,
    activeProject,
    recentProjectIds,
    openProjectWorkspace,
    activeGroupTabId,
    workspaceTabs,
    activeTabId,
    focusedTerminalId,
    createFilePane,
    openPane,
  } = useProjectsStore(
    useShallow((s) => ({
      allContainers: s.workspace.containers,
      projects: s.projects,
      groups: s.groups,
      flat: s.preferences.workspaceFlat,
      fullscreenId: s.preferences.fullscreenContainerId,
      setFullscreenContainer: s.setFullscreenContainer,
      reorderPane: s.reorderPaneInContainer,
      reorderContainers: s.reorderContainers,
      setWorkspaceGridLayout: s.setWorkspaceGridLayout,
      setGroupGridLayout: s.setGroupGridLayout,
      setProjectGridLayout: s.setProjectGridLayout,
      activeProject: selectActiveProject(s) ?? s.projects[0] ?? null,
      recentProjectIds: s.workspace.recentProjectIds,
      openProjectWorkspace: s.openProjectWorkspace,
      activeGroupTabId: s.workspace.activeGroupId,
      workspaceTabs: s.workspace.tabs,
      activeTabId: s.workspace.activeTabId,
      focusedTerminalId: s.workspace.focusedTerminalId,
      createFilePane: s.createFilePane,
      openPane: s.openPane,
    }))
  )

  const { openModal, requestPaneFocus, setKeptAlivePanes, setMountedPanes } = useUiStore(
    useShallow((s) => ({
      openModal: s.openModal_,
      requestPaneFocus: s.requestPaneFocus,
      setKeptAlivePanes: s.setKeptAlivePanes,
      setMountedPanes: s.setMountedPanes,
    }))
  )
  const initialWorkspaceEnsured = useRef(false)
  const fileDragDepth = useRef(0)
  const [fileDropActive, setFileDropActive] = useState(false)
  const t = useT()

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const [liveTabIds, setLiveTabIds] = useState<string[]>([])

  useEffect(() => {
    if (!activeTabId) return
    setLiveTabIds((prev) => {
      const known = new Set(workspaceTabs.map((tab) => tab.id))
      const next = [activeTabId, ...prev]
        .filter((id, index, list) => known.has(id) && list.indexOf(id) === index)
        .slice(0, MAX_LIVE_WORKSPACE_TABS)
      const unchanged = next.length === prev.length && next.every((id, i) => id === prev[i])
      return unchanged ? prev : next
    })
  }, [activeTabId, workspaceTabs])

  const surfaces = useMemo<WorkspaceSurface[]>(() => {
    const withinGroup = (list: WorkspaceContainer[], groupId: string | null) => {
      if (!groupId) return list
      const projectIds = collectGroupProjectIds(groupId, groups)
      return list.filter((container) => projectIds.has(container.projectId))
    }

    const entries: WorkspaceSurface[] = []
    if (!activeTabId) {
      entries.push({
        key: 'workspace',
        tabId: null,
        active: true,
        containers: withinGroup(allContainers, activeGroupTabId),
        activeGroupId: activeGroupTabId,
        flat,
      })
    } else {
      const orderedIds = [activeTabId, ...liveTabIds.filter((id) => id !== activeTabId)]
      for (const tabId of orderedIds) {
        const active = tabId === activeTabId
        const snapshot = workspaceTabs.find((tab) => tab.id === tabId)?.snapshot
        if (!snapshot && !active) continue
        const groupId = active ? activeGroupTabId : (snapshot?.activeGroupId ?? null)
        entries.push({
          key: tabId,
          tabId,
          active,
          containers: withinGroup(active ? allContainers : (snapshot?.containers ?? []), groupId),
          activeGroupId: groupId,
          flat: active ? flat : (snapshot?.workspaceFlat ?? flat),
        })
      }
    }

    // A pane may belong to several tabs; only the highest-priority surface renders it, so two
    // XTermView instances never attach to the same PTY at once.
    const claimed = new Set<string>()
    return entries.map((entry) => {
      const containers = entry.containers
        .map((container) => ({
          ...container,
          paneIds: container.paneIds.filter((id) => !claimed.has(id)),
        }))
        .filter((container) => container.paneIds.length > 0)
      for (const container of containers) for (const id of container.paneIds) claimed.add(id)
      return { ...entry, containers }
    })
  }, [activeGroupTabId, activeTabId, allContainers, flat, groups, liveTabIds, workspaceTabs])

  const containers = useMemo(
    () => surfaces.find((surface) => surface.active)?.containers ?? [],
    [surfaces],
  )

  const keptAlivePaneIds = useMemo(
    () =>
      surfaces
        .filter((surface) => !surface.active)
        .slice(0, MAX_STREAMING_BACKGROUND_TABS)
        .flatMap((surface) =>
          surface.containers.filter((c) => !c.collapsed).flatMap((c) => c.paneIds),
        ),
    [surfaces],
  )

  const mountedPaneIds = useMemo(
    () =>
      surfaces
        .filter((surface) => !surface.active)
        .flatMap((surface) =>
          surface.containers.filter((c) => !c.collapsed).flatMap((c) => c.paneIds),
        ),
    [surfaces],
  )

  useEffect(() => {
    setKeptAlivePanes(keptAlivePaneIds)
    return () => setKeptAlivePanes([])
  }, [keptAlivePaneIds, setKeptAlivePanes])

  useEffect(() => {
    setMountedPanes(mountedPaneIds)
    return () => setMountedPanes([])
  }, [mountedPaneIds, setMountedPanes])

  useEffect(() => {
    if (!focusedTerminalId) return
    requestPaneFocus(focusedTerminalId)
  }, [focusedTerminalId, requestPaneFocus])

  useEffect(() => {
    if (
      initialWorkspaceEnsured.current ||
      allContainers.length > 0 ||
      activeGroupTabId !== null ||
      projects.length === 0
    )
      return

    const recent = recentProjectIds
      .map((id) => projectsById.get(id))
      .find((project) => project && project.terminals.length > 0)
    const candidate = activeProject?.terminals.length
      ? activeProject
      : (recent ?? projects.find((project) => project.terminals.length > 0))
    if (!candidate) return

    initialWorkspaceEnsured.current = true
    openProjectWorkspace(candidate.id)
  }, [
    activeGroupTabId,
    activeProject,
    allContainers.length,
    openProjectWorkspace,
    projects,
    projectsById,
    recentProjectIds,
  ])

  useEffect(() => {
    if (!fullscreenId) return
    const c = containers.find((x) => x.projectId === fullscreenId)
    if (c && projectsById.has(c.projectId)) return
    setFullscreenContainer(null)
  }, [fullscreenId, containers, projectsById, setFullscreenContainer])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const onDragEnd = (e: DragEndEvent) => {
    const from = String(e.active.id)
    const to = e.over ? String(e.over.id) : ''
    if (!from || !to || from === to) return

    // cell:*: an empty slot of a custom grid — the dragged child just moves there.
    if (to.startsWith('cell:')) {
      const [, kind, ...rest] = to.split(':')
      const row = Number(rest.pop())
      const col = Number(rest.pop())
      if (!Number.isFinite(col) || !Number.isFinite(row)) return
      const state = useProjectsStore.getState()

      if (kind === 'pane' && from.startsWith('pane:')) {
        const projectId = rest.join(':')
        const paneId = from.slice('pane:'.length)
        const project = state.projects.find((p) => p.id === projectId)
        if (!project?.gridLayout) return
        const cont = allContainers.find((c) => c.projectId === projectId)
        if (!cont?.paneIds.includes(paneId)) return
        setProjectGridLayout(
          projectId,
          moveCellTo(project.gridLayout, cont.paneIds, paneId, col, row),
        )
        return
      }

      if (kind === 'cont' && from.startsWith('cont:')) {
        const projectId = from.slice('cont:'.length)
        const ids = containers.map((c) => c.projectId)
        const wsGrid = state.preferences.workspaceGridLayout
        if (wsGrid) {
          setWorkspaceGridLayout(moveCellTo(wsGrid, ids, projectId, col, row))
          return
        }
        const groupId =
          activeGroupTabId ?? state.projects.find((p) => p.id === projectId)?.groupId ?? null
        const grp = groupId ? state.groups.find((g) => g.id === groupId) : null
        if (grp?.gridLayout) {
          setGroupGridLayout(grp.id, moveCellTo(grp.gridLayout, ids, projectId, col, row))
        }
      }
      return
    }

    if (from.startsWith('pane:') && to.startsWith('pane:')) {
      const fromId = from.slice('pane:'.length)
      const toId = to.slice('pane:'.length)
      const cont = allContainers.find((c) => c.paneIds.includes(fromId) && c.paneIds.includes(toId))
      if (!cont) return
      const project = projectsById.get(cont.projectId)
      if (project?.layoutMode === 'grid' && project.gridLayout) {
        const cells = { ...project.gridLayout.cells }
        const a = cells[fromId]
        const b = cells[toId]
        if (a && b) {
          cells[fromId] = b
          cells[toId] = a
          setProjectGridLayout(project.id, { ...project.gridLayout, cells })
          return
        }
      }
      const fromIdx = cont.paneIds.indexOf(fromId)
      const toIdx = cont.paneIds.indexOf(toId)
      if (fromIdx !== -1 && toIdx !== -1) reorderPane(cont.projectId, fromIdx, toIdx)
      return
    }

    // cont: drag de container sobre outro.

    if (from.startsWith('cont:') && to.startsWith('cont:')) {
      const fromPid = from.slice('cont:'.length)
      const toPid = to.slice('cont:'.length)
      const state = useProjectsStore.getState()

      // workspace grid custom?
      const wsGrid = state.preferences.workspaceGridLayout
      if (wsGrid) {
        const cells = { ...wsGrid.cells }
        const a = cells[fromPid]
        const b = cells[toPid]
        if (a && b) {
          cells[fromPid] = b
          cells[toPid] = a
          setWorkspaceGridLayout({ ...wsGrid, cells })
          return
        }
      }

      if (activeGroupTabId) {
        const grp = state.groups.find((g) => g.id === activeGroupTabId)
        if (grp?.layoutMode === 'grid' && grp.gridLayout) {
          const cells = { ...grp.gridLayout.cells }
          const a = cells[fromPid]
          const b = cells[toPid]
          if (a && b) {
            cells[fromPid] = b
            cells[toPid] = a
            setGroupGridLayout(grp.id, { ...grp.gridLayout, cells })
            return
          }
        }
      }

      const groupIds = new Set(
        containers.map((c) => projectsById.get(c.projectId)?.groupId ?? null),
      )
      if (groupIds.size === 1) {
        const onlyGroupId = [...groupIds][0]
        if (onlyGroupId) {
          const grp = state.groups.find((g) => g.id === onlyGroupId)
          if (grp?.layoutMode === 'grid' && grp.gridLayout) {
            const cells = { ...grp.gridLayout.cells }
            const a = cells[fromPid]
            const b = cells[toPid]
            if (a && b) {
              cells[fromPid] = b
              cells[toPid] = a
              setGroupGridLayout(grp.id, { ...grp.gridLayout, cells })
              return
            }
          }
        }
      }

      // fallback: reorder linear
      const fromIdx = allContainers.findIndex((c) => c.projectId === fromPid)
      const toIdx = allContainers.findIndex((c) => c.projectId === toPid)
      if (fromIdx !== -1 && toIdx !== -1) reorderContainers(fromIdx, toIdx)
      return
    }
  }

  /** Wrapper compartilhado: workspace shell + DndContext. */
  const shell = (children: React.ReactNode, withDnd = true) => (
    <div
      className={`${styles.workspace} ${fileDropActive ? styles.fileDropActive : ''}`}
      onDragEnter={(event) => {
        if (!hasFileDragPayload(event.dataTransfer)) return
        event.preventDefault()
        fileDragDepth.current += 1
        setFileDropActive(true)
      }}
      onDragOver={(event) => {
        if (!hasFileDragPayload(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasFileDragPayload(event.dataTransfer)) return
        fileDragDepth.current = Math.max(0, fileDragDepth.current - 1)
        if (fileDragDepth.current === 0) setFileDropActive(false)
      }}
      onDrop={(event) => {
        const payload = readFileDragPayload(event.dataTransfer)
        if (!payload) return
        event.preventDefault()
        fileDragDepth.current = 0
        setFileDropActive(false)
        const pane = createFilePane(payload.projectId, { filePath: payload.path })
        openPane(payload.projectId, pane.id)
        requestPaneFocus(pane.id)
      }}
    >
      <div className={styles.area}>
        {withDnd ? (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {children}
          </DndContext>
        ) : (
          children
        )}
      </div>
      {fileDropActive ? (
        <div className={styles.fileDropOverlay}>{t('files.dropToGrid')}</div>
      ) : null}
    </div>
  )

  const hasAnyContainer = surfaces.some((surface) => surface.containers.length > 0)

  return shell(
    <div className={styles.surfaceStack}>
      {surfaces.map((surface) => (
        <WorkspaceSurfaceProvider
          key={surface.key}
          value={{ tabId: surface.tabId, active: surface.active }}
        >
          <div
            className={`${styles.surface} ${surface.active ? '' : styles.surfaceHidden}`}
            aria-hidden={surface.active ? undefined : true}
          >
            {surface.containers.length === 0 ? (
              surface.active ? (
                <NoWorkspace
                  project={activeProject}
                  onAddTerminal={(defaultCwd) =>
                    activeProject
                      ? openModal('newTerminal', { projectId: activeProject.id })
                      : openModal('newProject', defaultCwd ? { defaultCwd } : undefined)
                  }
                />
              ) : null
            ) : (
              <SurfaceLayout
                containers={surface.containers}
                activeGroupTabId={surface.activeGroupId}
                flat={surface.flat}
                fullscreenId={surface.active ? fullscreenId : null}
                projectsById={projectsById}
                groupsById={groupsById}
              />
            )}
          </div>
        </WorkspaceSurfaceProvider>
      ))}
    </div>,
    hasAnyContainer,
  )
}

function SurfaceLayout({
  containers,
  activeGroupTabId,
  flat,
  fullscreenId,
  projectsById,
  groupsById,
}: {
  containers: WorkspaceContainer[]
  activeGroupTabId: string | null
  flat: boolean
  fullscreenId: string | null
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
}) {
  // Fullscreen has its own path via `isolatedPaneId` — see ProjectContainer.tsx.
  if (fullscreenId) {
    const c = containers.find((x) => x.projectId === fullscreenId)
    const project = c ? projectsById.get(c.projectId) : null
    if (c && project) {
      return (
        <ProjectContainer
          container={c}
          project={project}
          group={resolveGroup(project, groupsById)}
          isFullscreen
        />
      )
    }
  }

  if (flat) {
    const flatPanes: { projectId: string; terminal: Terminal }[] = []
    for (const c of containers) {
      const project = projectsById.get(c.projectId)
      if (!project) continue
      const map = new Map(project.terminals.map((t) => [t.id, t]))
      for (const pid of c.paneIds) {
        const t = map.get(pid)
        if (t) flatPanes.push({ projectId: c.projectId, terminal: t })
      }
    }
    if (flatPanes.length === 0) return null
    return (
      <PaneArea
        projectId={flatPanes[0].projectId}
        idPrefix="flat"
        terminals={flatPanes.map((f) => f.terminal)}
        layoutMode="auto"
      />
    )
  }

  if (containers.length === 1) {
    const c = containers[0]
    const project = projectsById.get(c.projectId)
    if (!project) return null
    return (
      <ProjectContainer
        container={c}
        project={project}
        group={resolveGroup(project, groupsById)}
        showHeader={false}
      />
    )
  }

  // 2+ containers → auto-grid
  return (
    <ContainerAutoGrid
      containers={containers}
      projectsById={projectsById}
      groupsById={groupsById}
      activeGroupTabId={activeGroupTabId}
    />
  )
}

function ContainerAutoGrid({
  containers,
  projectsById,
  groupsById,
  activeGroupTabId,
}: {
  containers: WorkspaceContainer[]
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
  activeGroupTabId: string | null
}) {
  const workspaceGridLayout = useProjectsStore((s) => s.preferences.workspaceGridLayout)

  const activeGroup = activeGroupTabId ? groupsById.get(activeGroupTabId) : null
  if (workspaceGridLayout) {
    return (
      <GroupGridOuter
        containers={containers}
        projectsById={projectsById}
        groupsById={groupsById}
        layout={workspaceGridLayout}
        scope={{ kind: 'workspace' }}
      />
    )
  }

  if (activeGroup?.layoutMode === 'grid' && activeGroup.gridLayout) {
    return (
      <GroupGridOuter
        containers={containers}
        projectsById={projectsById}
        groupsById={groupsById}
        layout={activeGroup.gridLayout}
        scope={{ kind: 'group', id: activeGroup.id }}
      />
    )
  }

  const groupId = (() => {
    const ids = new Set(containers.map((c) => projectsById.get(c.projectId)?.groupId ?? null))
    if (ids.size === 1) {
      const only = [...ids][0]
      if (only) return only
    }
    return null
  })()
  const group = groupId ? groupsById.get(groupId) : null
  if (group?.layoutMode === 'grid' && group.gridLayout) {
    return (
      <GroupGridOuter
        containers={containers}
        projectsById={projectsById}
        groupsById={groupsById}
        layout={group.gridLayout}
        scope={{ kind: 'group', id: group.id }}
      />
    )
  }

  if (containers.length === 2) {
    return (
      <PanelGroup
        orientation="horizontal"
        className={styles.fullSize}
        persistenceId="workspace-container-columns"
        panelIds={containers.map((container) => `outer-${container.projectId}`)}
      >
        {containers.map((c, i) => {
          const project = projectsById.get(c.projectId)
          if (!project) return null
          const group = resolveGroup(project, groupsById)
          const isLast = i === containers.length - 1
          const minSize = c.collapsed ? '0%' : '15%'
          const defaultSize = c.collapsed ? '4%' : undefined
          return (
            <ContainerPanelFragment
              key={c.projectId}
              container={c}
              project={project}
              group={group}
              panelId={`outer-${c.projectId}`}
              minSize={minSize}
              defaultSize={defaultSize}
              isLast={isLast}
              sepClass={styles.sepH}
            />
          )
        })}
      </PanelGroup>
    )
  }

  const rows: WorkspaceContainer[][] = []
  for (let i = 0; i < containers.length; i += 2) {
    rows.push(containers.slice(i, i + 2))
  }
  const rowPanelIds = rows.map((_, rowIndex) => `outer-row-${rowIndex}`)
  return (
    <PanelGroup
      orientation="vertical"
      className={styles.fullSize}
      persistenceId="workspace-container-rows"
      panelIds={rowPanelIds}
    >
      {rows.map((row, ri) => {
        const isLastRow = ri === rows.length - 1
        const rowId = `outer-row-${ri}`
        return (
          <FragmentRowOuter
            key={ri}
            row={row}
            rowId={rowId}
            projectsById={projectsById}
            groupsById={groupsById}
            isLastRow={isLastRow}
          />
        )
      })}
    </PanelGroup>
  )
}

function FragmentRowOuter({
  row,
  rowId,
  projectsById,
  groupsById,
  isLastRow,
}: {
  row: WorkspaceContainer[]
  rowId: string
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
  isLastRow: boolean
}) {
  return (
    <>
      <Panel id={rowId} minSize="10%">
        {row.length === 1 ? (
          <SingleContainer container={row[0]} projectsById={projectsById} groupsById={groupsById} />
        ) : (
          <PanelGroup
            orientation="horizontal"
            className={styles.fullSize}
            persistenceId={`workspace-container-row-${rowId}`}
            panelIds={row.map((container) => `outer-${container.projectId}`)}
          >
            {row.map((c, i) => {
              const project = projectsById.get(c.projectId)
              if (!project) return null
              const group = resolveGroup(project, groupsById)
              const isLast = i === row.length - 1
              const minSize = c.collapsed ? '0%' : '15%'
              const defaultSize = c.collapsed ? '4%' : undefined
              return (
                <ContainerPanelFragment
                  key={c.projectId}
                  container={c}
                  project={project}
                  group={group}
                  panelId={`outer-${c.projectId}`}
                  minSize={minSize}
                  defaultSize={defaultSize}
                  isLast={isLast}
                  sepClass={styles.sepH}
                />
              )
            })}
          </PanelGroup>
        )}
      </Panel>
      {isLastRow ? null : <Separator className={styles.sepV} />}
    </>
  )
}

type OuterGridScope = { kind: 'workspace' } | { kind: 'group'; id: string }

function GroupGridOuter({
  containers,
  projectsById,
  groupsById,
  layout,
  scope,
}: {
  containers: WorkspaceContainer[]
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
  layout: GridLayout
  scope: OuterGridScope
}) {
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)
  const setGroupGridLayout = useProjectsStore((s) => s.setGroupGridLayout)
  const ids = containers.map((c) => c.projectId)
  const reconciled = reconcileGridLayout(layout, ids)
  const onUpdate = (next: GridLayout) => {
    if (scope.kind === 'workspace') setWorkspaceGridLayout(next)
    else setGroupGridLayout(scope.id, next)
  }
  return (
    <div style={gridContainerStyle(reconciled)}>
      {freeCells(reconciled, ids).map((slot) => (
        <EmptyOuterSlot
          key={`slot-${slot.col}-${slot.row}`}
          dropId={`cell:cont:${slot.col}:${slot.row}`}
          col={slot.col}
          row={slot.row}
        />
      ))}
      {containers.map((c) => {
        const cell = reconciled.cells[c.projectId]
        if (!cell) return null
        const project = projectsById.get(c.projectId)
        if (!project) return null
        const group = resolveGroup(project, groupsById)
        return (
          <div key={c.projectId} className={styles.gridCell} style={cellStyle(cell)}>
            <ProjectContainer container={c} project={project} group={group} />
            <GridCellHandles
              cellId={c.projectId}
              childIds={ids}
              layout={reconciled}
              onUpdate={onUpdate}
            />
          </div>
        )
      })}
    </div>
  )
}

function EmptyOuterSlot({ dropId, col, row }: { dropId: string; col: number; row: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId })
  return (
    <div
      ref={setNodeRef}
      className={`${styles.emptySlot} ${isOver ? styles.emptySlotOver : ''}`}
      style={{ gridColumn: col, gridRow: row }}
    />
  )
}

function SingleContainer({
  container,
  projectsById,
  groupsById,
}: {
  container: WorkspaceContainer
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
}) {
  const project = projectsById.get(container.projectId)
  if (!project) return null
  const group = resolveGroup(project, groupsById)
  return <ProjectContainer container={container} project={project} group={group} />
}

function ContainerPanelFragment({
  container,
  project,
  group,
  panelId,
  minSize,
  defaultSize,
  isLast,
  sepClass,
}: {
  container: WorkspaceContainer
  project: Project
  group: Group | null
  panelId: string
  minSize: string
  defaultSize?: string
  isLast: boolean
  sepClass: string
}) {
  return (
    <>
      <Panel id={panelId} minSize={minSize} defaultSize={defaultSize}>
        <ProjectContainer container={container} project={project} group={group} />
      </Panel>
      {isLast ? null : <Separator className={sepClass} />}
    </>
  )
}

function NoWorkspace({
  project,
  onAddTerminal,
}: {
  project: Project | null
  onAddTerminal: (defaultCwd?: string) => void
}) {
  const t = useT()
  const openContainerWithAllPanes = useProjectsStore((s) => s.openContainerWithAllPanes)
  const createProject = useProjectsStore((s) => s.createProject)
  const createTerminal = useProjectsStore((s) => s.createTerminal)
  const openTerminalWorkspace = useProjectsStore((s) => s.openTerminalWorkspace)
  const setGraphifyEnabled = useProjectsStore((s) => s.setGraphifyEnabled)
  const [folder, setFolder] = useState('')
  const [graphifyEnabled, setGraphifyEnabledState] = useState(false)
  const enabledAgents = useProjectsStore((s) => s.preferences.enabledAgents)
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
  const quickAgents = useMemo(
    () =>
      (['claude', 'codex', 'antigravity', 'opencode', 'shell'] as AgentType[]).filter(
        (agent) => enabledAgents[agent],
      ),
    [enabledAgents],
  )
  const [quickAgent, setQuickAgent] = useState<AgentType>('claude')

  useEffect(() => {
    if (!project) return
    const projectFolder = project.defaultCwd || project.terminals[0]?.cwd || ''
    if (projectFolder) setFolder(projectFolder)
  }, [project])

  useEffect(() => {
    if (!quickAgents.includes(quickAgent)) setQuickAgent(quickAgents[0] ?? 'shell')
  }, [quickAgent, quickAgents])

  const browseFolder = async () => {
    const selected = await pickDirectory({ defaultPath: folder || undefined })
    if (selected) setFolder(selected)
  }

  const openFolderAsProject = () => {
    const cwd = folder.trim()
    if (!cwd) return
    const normalized = cwd.replace(/[\\/]+$/, '')
    const name = normalized.split(/[\\/]/).filter(Boolean).pop() || normalized
    const existingProjectFolder = project?.defaultCwd || project?.terminals[0]?.cwd
    if (
      project &&
      existingProjectFolder?.replace(/[\\/]+$/, '').toLowerCase() === normalized.toLowerCase()
    ) {
      const terminal = createTerminal(project.id, {
        name: quickAgent[0].toUpperCase() + quickAgent.slice(1),
        cwd,
        firstTab: { type: quickAgent, cwd, runtimeProfile: 'lean' },
      })
      openTerminalWorkspace(project.id, terminal.id)
      return
    }
    const createdProject = createProject({ name, defaultCwd: cwd })
    if (graphifyEnabled) setGraphifyEnabled(createdProject.id, true)
    const terminal = createTerminal(createdProject.id, {
      name: quickAgent[0].toUpperCase() + quickAgent.slice(1),
      cwd,
      firstTab: { type: quickAgent, cwd, runtimeProfile: 'lean' },
    })
    openTerminalWorkspace(createdProject.id, terminal.id)
  }
  if (!project) {
    return (
      <div className={styles.emptyShell}>
        <div className={styles.emptyProjectCard}>
          <div className={styles.emptyProjectIntro}>
            <div className={styles.emptyProjectIcon}>
              <FolderPlus size={22} />
            </div>
            <strong>{t('ws.emptyProjectTitle')}</strong>
            <span>{t('ws.emptyProjectDesc')}</span>
          </div>
          <div className={styles.emptyFolderLabel}>{t('ws.emptyAgentLabel')}</div>
          <div className={styles.emptyAgentGrid}>
            {quickAgents.map((agent) => (
              <button
                key={agent}
                type="button"
                className={`${styles.emptyAgentButton} ${quickAgent === agent ? styles.emptyAgentButtonActive : ''}`}
                onClick={() => setQuickAgent(agent)}
              >
                <AgentIcon type={agent} size={15} theme={terminalTheme} />
                <span>{agent[0].toUpperCase() + agent.slice(1)}</span>
              </button>
            ))}
          </div>
          <div className={styles.emptyFolderLabel}>{t('ws.emptyFolderLabel')}</div>
          <div className={styles.emptyFolderRow}>
            <button
              type="button"
              className={styles.emptyFolderButton}
              onClick={() => void browseFolder()}
            >
              <FolderOpen size={14} />
              <span title={folder || undefined}>{folder || t('ws.emptyFolderPlaceholder')}</span>
            </button>
            <button
              type="button"
              className={styles.emptyFolderAction}
              disabled={!folder.trim()}
              onClick={openFolderAsProject}
            >
              {t('ws.emptyFolderAction')}
            </button>
          </div>
          <label className={styles.emptyGraphifyToggle}>
            <input
              type="checkbox"
              checked={graphifyEnabled}
              onChange={(event) => setGraphifyEnabledState(event.target.checked)}
            />
            <span>{t('project.graphifyEnabled')}</span>
          </label>
          <button
            type="button"
            className={styles.emptySecondaryAction}
            onClick={() => onAddTerminal(folder.trim() || undefined)}
          >
            {t('ws.emptyModalAction')}
          </button>
        </div>
      </div>
    )
  }
  if (project.terminals.length === 0) {
    return (
      <div className={styles.emptyShell}>
        <EmptyState
          icon={<TerminalSquare size={22} />}
          title={t('ws.emptyTerminalTitle')}
          description={t('ws.emptyTerminalDesc')}
          primaryAction={{
            label: t('ws.emptyTerminalAction'),
            onClick: onAddTerminal,
          }}
        />
      </div>
    )
  }
  return (
    <div className={styles.emptyShell}>
      <EmptyState
        icon={<TerminalSquare size={22} />}
        title={t('ws.emptyContainerTitle')}
        description={t('ws.emptyContainerDesc', { count: project.terminals.length })}
        primaryAction={{
          label: t('ws.emptyContainerAction'),
          onClick: () => openContainerWithAllPanes(project.id),
        }}
      />
    </div>
  )
}
