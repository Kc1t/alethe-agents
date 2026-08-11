import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { FolderOpen, FolderPlus, TerminalSquare } from 'lucide-react'
import { Group as PanelGroup, Panel, Separator } from 'react-resizable-panels'
import { useEffect, useMemo, useRef, useState } from 'react'

import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { pickDirectory } from '../../lib/dialog'
import { useT } from '../../lib/i18n'
import { cellStyle, gridContainerStyle, reconcileGridLayout } from '../../lib/gridLayout'
import type { AgentType, GridLayout, Group, Project, Terminal, WorkspaceContainer } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'
import { EmptyState } from '../EmptyState'
import { PaneArea } from './PaneArea'
import { ProjectContainer } from './ProjectContainer'
import styles from './WorkspaceView.module.css'

function resolveGroup(project: Project, groupsById: Map<string, Group>): Group | null {
  return project.groupId ? (groupsById.get(project.groupId) ?? null) : null
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
  const allContainers = useProjectsStore((s) => s.workspace.containers)
  const projects = useProjectsStore((s) => s.projects)
  const groups = useProjectsStore((s) => s.groups)
  const flat = useProjectsStore((s) => s.preferences.workspaceFlat)
  const fullscreenId = useProjectsStore((s) => s.preferences.fullscreenContainerId)
  const setFullscreenContainer = useProjectsStore((s) => s.setFullscreenContainer)
  const reorderPane = useProjectsStore((s) => s.reorderPaneInContainer)
  const reorderContainers = useProjectsStore((s) => s.reorderContainers)
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)
  const setGroupGridLayout = useProjectsStore((s) => s.setGroupGridLayout)
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const activeProject = useProjectsStore((state) => selectActiveProject(state) ?? state.projects[0] ?? null)
  const recentProjectIds = useProjectsStore((s) => s.workspace.recentProjectIds)
  const openProjectWorkspace = useProjectsStore((s) => s.openProjectWorkspace)
  const openModal = useUiStore((s) => s.openModal_)
  const activeGroupTabId = useProjectsStore((s) => s.workspace.activeGroupId)
  const focusedTerminalId = useProjectsStore((s) => s.workspace.focusedTerminalId)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const initialWorkspaceEnsured = useRef(false)

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const groupsById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  const activeGroupProjectIds = useMemo(
    () => (activeGroupTabId ? collectGroupProjectIds(activeGroupTabId, groups) : null),
    [activeGroupTabId, groups],
  )
  const containers = useMemo(
    () =>
      activeGroupTabId === null
        ? allContainers
        : allContainers.filter((c) => activeGroupProjectIds?.has(c.projectId)),
    [activeGroupTabId, activeGroupProjectIds, allContainers],
  )

  useEffect(() => {
    if (!focusedTerminalId) return
    requestPaneFocus(focusedTerminalId)
  }, [focusedTerminalId, requestPaneFocus])

  // Um projects.json pode ter projetos válidos, mas nenhuma aba/container
  // restaurável (por exemplo, depois de um primeiro boot ou de uma migração).
  // Nesse caso, abrir a Workspace vazia e pedir "Criar projeto" é enganoso:
  // selecione o projeto recente com terminais uma única vez.
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

  // Container/projeto de fullscreenContainerId pode deixar de existir nesta
  // vista (removido, filtrado por grupo, etc.) — sem isso o botão de tela
  // cheia "trava": o estado fica preso apontando pra um alvo que nunca mais
  // renderiza fullscreen, mas também não volta pra vista normal sozinho.
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

    // pane: reordena dentro do mesmo container.
    // Se o projeto está em modo grid, faz SWAP das células do grid (não da
    // ordem linear) — assim o card vai pra posição visual do alvo.
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
    // Se há grid layout ativo (workspace OU grupo), SWAP das células.
    // Senão, reorder linear no array.
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

      // group grid da tab ativa (grupo/subgrupo), incluindo descendentes.
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

      // group grid (todos os containers no mesmo grupo direto)?
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
    <div className={styles.workspace}>
      <div className={styles.area}>
        {withDnd ? (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            {children}
          </DndContext>
        ) : (
          children
        )}
      </div>
    </div>
  )

  // estado vazio
  if (containers.length === 0) {
    return shell(
      <NoWorkspace
        project={activeProject}
        onAddTerminal={(defaultCwd) =>
          activeProject
            ? openModal('newTerminal', { projectId: activeProject.id })
            : openModal('newProject', defaultCwd ? { defaultCwd } : undefined)
        }
      />,
      false,
    )
  }

  // fullscreen: só o container escolhido (a gaveta GSD Sync usa o mesmo
  // caminho, via `isolatedPaneId` — ver ProjectContainer.tsx)
  if (fullscreenId) {
    const c = containers.find((x) => x.projectId === fullscreenId)
    const project = c ? projectsById.get(c.projectId) : null
    if (c && project) {
      return shell(
        <ProjectContainer
          container={c}
          project={project}
          group={resolveGroup(project, groupsById)}
          isFullscreen
        />,
      )
    }
  }

  // modo flat — junta todos os panes num grid sem containers
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
    return shell(
      <PaneArea
        projectId={flatPanes[0].projectId}
        idPrefix="flat"
        terminals={flatPanes.map((f) => f.terminal)}
        layoutMode="auto"
      />,
    )
  }

  // container único
  if (containers.length === 1) {
    const c = containers[0]
    const project = projectsById.get(c.projectId)
    if (!project) return null
    return shell(
      <ProjectContainer
        container={c}
        project={project}
        group={resolveGroup(project, groupsById)}
        showHeader={false}
      />,
    )
  }

  // 2+ containers → auto-grid
  return shell(
    <ContainerAutoGrid
      containers={containers}
      projectsById={projectsById}
      groupsById={groupsById}
      activeGroupTabId={activeGroupTabId}
    />,
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
  // Prioridade: 1) workspace custom  2) grupo/subgrupo ativo
  // 3) grupo direto único  4) auto-grid
  const activeGroup = activeGroupTabId ? groupsById.get(activeGroupTabId) : null
  if (workspaceGridLayout) {
    return (
      <GroupGridOuter
        containers={containers}
        projectsById={projectsById}
        groupsById={groupsById}
        layout={workspaceGridLayout}
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
      />
    )
  }
  // Detecta se todos os containers pertencem ao MESMO grupo com gridLayout salvo.
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
      />
    )
  }

  if (containers.length === 2) {
    return (
      <PanelGroup orientation="horizontal" className={styles.fullSize}>
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

  // 3+ → vira grid: linhas verticais com no máx 2 containers por linha
  const rows: WorkspaceContainer[][] = []
  for (let i = 0; i < containers.length; i += 2) {
    rows.push(containers.slice(i, i + 2))
  }
  return (
    <PanelGroup orientation="vertical" className={styles.fullSize}>
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
          <PanelGroup orientation="horizontal" className={styles.fullSize}>
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

function GroupGridOuter({
  containers,
  projectsById,
  groupsById,
  layout,
}: {
  containers: WorkspaceContainer[]
  projectsById: Map<string, Project>
  groupsById: Map<string, Group>
  layout: GridLayout
}) {
  const ids = containers.map((c) => c.projectId)
  const reconciled = reconcileGridLayout(layout, ids)
  return (
    <div style={gridContainerStyle(reconciled)}>
      {containers.map((c) => {
        const cell = reconciled.cells[c.projectId]
        if (!cell) return null
        const project = projectsById.get(c.projectId)
        if (!project) return null
        const group = resolveGroup(project, groupsById)
        return (
          <div key={c.projectId} className={styles.gridCell} style={cellStyle(cell)}>
            <ProjectContainer container={c} project={project} group={group} />
          </div>
        )
      })}
    </div>
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
    if (project && existingProjectFolder?.replace(/[\\/]+$/, '').toLowerCase() === normalized.toLowerCase()) {
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
            <div className={styles.emptyProjectIcon}><FolderPlus size={22} /></div>
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
