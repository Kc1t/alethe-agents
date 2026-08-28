import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Folder,
  FolderPlus,
  GitBranch,
  Grid3x3,
  Home,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import {
  sidebarDragKind,
  type SidebarDropIndicator,
  sidebarInsertionIndex,
} from '../../lib/sidebarDrag'
import { type Group, type Project } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { EmptyState } from '../EmptyState'
import { SidebarNowPlaying } from '../SidebarNowPlaying'
import { UserProfile } from '../UserProfile'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FileExplorer } from './FileExplorer'
import { GitControl } from './GitControl'
import { NormalGroupNode as GroupNode } from './NormalGroupNode'
import { LayoutFooter, WorkspaceLayoutFooter } from './LayoutFooter'
import { NormalProjectNode as ProjectNode } from './NormalProjectNode'
import styles from './NormalProjectSidebar.module.css'
import { createSidebarMenus } from './sidebarMenus'
import { SidebarMergePanel } from './SidebarMergePanel'
import { SidebarUpdate } from './SidebarUpdate'

type ContextMenuState = { x: number; y: number; items: MenuItem[] } | null

const sidebarCollisionDetection: CollisionDetection = (args) => {
  const kind = sidebarDragKind(String(args.active.id))
  const candidates = pointerWithin(args).filter(({ id }) => {
    const target = String(id)
    if (target === String(args.active.id)) return false
    if (kind === 'terminal') return target.startsWith('proj:')
    if (kind === 'project') return target.startsWith('proj:') || target.startsWith('group:')
    if (kind === 'group') {
      const sourceId = String(args.active.id).slice('grp:'.length)
      return (
        target !== `group:${sourceId}` && (target.startsWith('grp:') || target.startsWith('group:'))
      )
    }
    return false
  })

  const rank = (id: string) => {
    if (kind === 'project') return id.startsWith('proj:') ? 0 : 1
    if (kind === 'group') return id.startsWith('grp:') ? 0 : 1
    return 0
  }

  return candidates.sort((a, b) => {
    const rankDifference = rank(String(a.id)) - rank(String(b.id))
    if (rankDifference !== 0) return rankDifference
    const aRect = args.droppableRects.get(a.id)
    const bRect = args.droppableRects.get(b.id)
    const aArea = aRect ? aRect.width * aRect.height : Number.POSITIVE_INFINITY
    const bArea = bRect ? bRect.width * bRect.height : Number.POSITIVE_INFINITY
    return aArea - bArea
  })
}

function dropIndicatorForEvent(event: DragMoveEvent | DragEndEvent): SidebarDropIndicator | null {
  if (!event.over) return null
  const id = String(event.over.id)
  if (id.startsWith('group:') || sidebarDragKind(String(event.active.id)) === 'terminal') {
    return { id, edge: 'inside' }
  }

  const activatorEvent = event.activatorEvent
  const pointerY =
    'clientY' in activatorEvent && typeof activatorEvent.clientY === 'number'
      ? activatorEvent.clientY + event.delta.y
      : event.active.rect.current.translated
        ? event.active.rect.current.translated.top + event.active.rect.current.translated.height / 2
        : event.over.rect.top + event.over.rect.height / 2
  const edge = pointerY < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after'
  return { id, edge }
}

export function NormalProjectSidebar() {
  const t = useT()
  // --- data selectors (reactive) ---
  const projects = useProjectsStore((s) => s.projects)
  const groups = useProjectsStore((s) => s.groups)
  const ungroupedOrder = useProjectsStore((s) => s.ungroupedOrder)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const showGitControl = useProjectsStore((s) => s.preferences.enabledFeatures.git)
  const preferences = useProjectsStore((s) => s.preferences)

  // --- action selectors (stable refs, grouped for readability) ---
  const actions = useProjectsStore(
    useShallow((s) => ({
      setActiveProject: s.setActiveProject,
      openGroupScope: s.openGroupScope,
      openProjectWorkspace: s.openProjectWorkspace,
      addProjectToWorkspace: s.addProjectToWorkspace,
      openGroupWorkspace: s.openGroupWorkspace,
      openTerminalWorkspace: s.openTerminalWorkspace,
      addTerminalToWorkspace: s.addTerminalToWorkspace,
      focusWorkspaceTerminal: s.focusWorkspaceTerminal,
      toggleProjectCollapsed: s.toggleProjectCollapsed,
      toggleGroupCollapsed: s.toggleGroupCollapsed,
      archiveGroup: s.archiveGroup,
      renameProject: s.renameProject,
      archiveProject: s.archiveProject,
      deleteProject: s.deleteProject,
      renameGroup: s.renameGroup,
      deleteGroup: s.deleteGroup,
      resumeGroup: s.resumeGroup,
      setProjectDisabled: s.setProjectDisabled,
      renameTerminal: s.renameTerminal,
      killTerminal: s.killTerminal,
      deleteTerminal: s.deleteTerminal,
      deleteTerminalWithWorktreeCleanup: s.deleteTerminalWithWorktreeCleanup,
      setTerminalDisabled: s.setTerminalDisabled,
      moveTerminal: s.moveTerminal,
      moveProjectToGroup: s.moveProjectToGroup,
      moveGroupToParent: s.moveGroupToParent,
      reorderProjectInGroup: s.reorderProjectInGroup,
      reorderUngrouped: s.reorderUngrouped,
      reorderGroups: s.reorderGroups,
      togglePane: s.togglePane,
      setLaneVisible: s.setLaneVisible,
      setTerminalRemoteExcluded: s.setTerminalRemoteExcluded,
      setSubTabCompletionUnread: s.setSubTabCompletionUnread,
      createFilePane: s.createFilePane,
      createGraphifyPane: s.createGraphifyPane,
      setFullscreenPane: s.setFullscreenPane,
    })),
  )

  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const openModal = useUiStore((s) => s.openModal_)
  const activeView = useUiStore((s) => s.activeView)
  const setActiveView = useUiStore((s) => s.setActiveView)
  const activeTerminalRef = useUiStore((s) => s.activeTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const setFocusedTerminal = useUiStore((s) => s.setFocusedTerminal)
  const openMarkdownSidebar = useUiStore((s) => s.openMarkdownSidebar)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [menu, setMenu] = useState<ContextMenuState>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<SidebarDropIndicator | null>(null)
  const [sidebarTab, setSidebarTab] = useState<'files' | 'git' | 'projects'>('projects')
  const keepHome = activeView === 'home'

  useEffect(() => {
    if (!showGitControl && sidebarTab === 'git') setSidebarTab('projects')
  }, [showGitControl, sidebarTab])

                                                                         
  const openPaneSets = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const c of containers) map[c.projectId] = new Set(c.paneIds)
    return map
  }, [containers])

  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const activeProject = useMemo(
    () => projectsById.get(activeProjectId ?? '') ?? projects[0] ?? null,
    [activeProjectId, projects, projectsById],
  )
  const selectedTerminal = useMemo(() => {
    if (!activeProject) return null
    if (activeTerminalRef?.projectId === activeProject.id) {
      const selected = activeProject.terminals.find(
        (terminal) => terminal.id === activeTerminalRef.terminalId,
      )
      if (selected) return selected
    }
    const activeContainer = containers.find((container) => container.projectId === activeProject.id)
    const visible = new Set(activeContainer?.paneIds ?? [])
    return (
      [...activeProject.terminals]
        .filter((terminal) => visible.size === 0 || visible.has(terminal.id))
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? null
    )
  }, [activeProject, activeTerminalRef, containers])
  // Terminal real (com cwd/tabs) para o explorer e git — ignora viewers (file/diff/web)
  const sidebarTerminal = useMemo(() => {
    if (selectedTerminal && !selectedTerminal.kind) return selectedTerminal
    if (!activeProject) return null
    return (
      [...activeProject.terminals]
        .filter((t) => !t.kind)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0] ?? null
    )
  }, [selectedTerminal, activeProject])
  const sidebarSubTab =
    sidebarTerminal?.tabs.find((tab) => tab.id === sidebarTerminal.activeTabId) ??
    sidebarTerminal?.tabs[0]

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const clearDragState = () => {
    setDraggingId(null)
    setDropIndicator(null)
  }

  const updateDropIndicator = (event: DragMoveEvent) => {
    const next = dropIndicatorForEvent(event)
    setDropIndicator((current) =>
      current?.id === next?.id && current?.edge === next?.edge ? current : next,
    )
  }

  const onDragEnd = (event: DragEndEvent) => {
    const indicator = dropIndicatorForEvent(event)
    clearDragState()
    const { active, over } = event
    if (!over || !indicator) return
    const dragged = String(active.id)
    const target = String(over.id)
    if (dragged === target) return

                                                                                        
    if (dragged.startsWith('term:') && target.startsWith('proj:')) {
      const [, fromProject, terminalId] = dragged.split(':')
      const [, toProject] = target.split(':')
      if (fromProject !== toProject) actions.moveTerminal(fromProject, terminalId, toProject)
      return
    }

                                                                                
                                                                              
    if (dragged.startsWith('proj:') && target.startsWith('proj:')) {
      const fromId = dragged.slice('proj:'.length)
      const toId = target.slice('proj:'.length)
      const from = projectsById.get(fromId)
      const to = projectsById.get(toId)
      if (!from || !to) return

      if (from.groupId === to.groupId) {
        const edge = indicator.edge === 'inside' ? 'before' : indicator.edge
        if (from.groupId === null) {
          const ord = useProjectsStore.getState().ungroupedOrder
          const fi = ord.indexOf(fromId)
          const ti = ord.indexOf(toId)
          if (fi !== -1 && ti !== -1) {
            actions.reorderUngrouped(fromId, fi, sidebarInsertionIndex(fi, ti, edge, true))
          }
        } else {
          const grp = useProjectsStore.getState().groups.find((g) => g.id === from.groupId)
          if (!grp) return
          const fi = grp.projectIds.indexOf(fromId)
          const ti = grp.projectIds.indexOf(toId)
          if (fi !== -1 && ti !== -1) {
            actions.reorderProjectInGroup(fromId, fi, sidebarInsertionIndex(fi, ti, edge, true))
          }
        }
      } else {
        const targetParent = to.groupId
        const targetIndex =
          targetParent === null
            ? useProjectsStore.getState().ungroupedOrder.indexOf(toId)
            : (useProjectsStore
                .getState()
                .groups.find((group) => group.id === targetParent)
                ?.projectIds.indexOf(toId) ?? -1)
        const edge = indicator.edge === 'inside' ? 'before' : indicator.edge
        const atIndex =
          targetIndex === -1 ? undefined : sidebarInsertionIndex(0, targetIndex, edge, false)
        actions.moveProjectToGroup(fromId, targetParent, atIndex)
      }
      return
    }

                                                                           
    if (dragged.startsWith('proj:') && target.startsWith('group:')) {
      const [, projectId] = dragged.split(':')
      const [, groupId] = target.split(':')
      actions.moveProjectToGroup(projectId, groupId === 'ungrouped' ? null : groupId)
      return
    }

    // grp:<id> → grp:<id> reorders groups among the target's siblings.
    if (dragged.startsWith('grp:') && target.startsWith('grp:')) {
      const fromId = dragged.slice('grp:'.length)
      const toId = target.slice('grp:'.length)
      const all = useProjectsStore.getState().groups
      const from = all.find((group) => group.id === fromId)
      const to = all.find((group) => group.id === toId)
      if (!from || !to) return
      const siblings = all.filter((group) => group.parentGroupId === to.parentGroupId)
      const targetIndex = siblings.findIndex((group) => group.id === toId)
      const sourceIndex = siblings.findIndex((group) => group.id === fromId)
      const sameParent = from.parentGroupId === to.parentGroupId
      const edge = indicator.edge === 'inside' ? 'before' : indicator.edge
      const atIndex = sidebarInsertionIndex(sourceIndex, targetIndex, edge, sameParent)
      actions.moveGroupToParent(fromId, to.parentGroupId, atIndex)
      return
    }

                                                                        
    if (dragged.startsWith('grp:') && target.startsWith('group:')) {
      const [, srcGroupId] = dragged.split(':')
      const [, parentId] = target.split(':')
      actions.moveGroupToParent(srcGroupId, parentId === 'ungrouped' ? null : parentId)
      return
    }
  }

  const draggingLabel = draggingId
    ? draggingId.startsWith('proj:')
      ? projectsById.get(draggingId.slice('proj:'.length))?.name
      : draggingId.startsWith('grp:')
        ? groups.find((group) => `grp:${group.id}` === draggingId)?.name
        : draggingId.startsWith('term:')
          ? 'Terminal'
          : null
    : null
  const draggingKind = sidebarDragKind(draggingId)

  const { projectMenu, groupMenu, terminalMenu } = createSidebarMenus({
    t,
    graphifyEnabled: preferences.enabledFeatures.graphify,
    browserEnabled: preferences.enabledFeatures.browser,
    groups: groups.filter((group) => !group.archived),
    openPaneSets,
    actions: { ...actions, setPreferences },
    openModal,
    setActiveView,
    setActiveTerminal,
    setFocusedTerminal,
    requestPaneFocus,
    openMarkdownSidebar,
  })

  const activateProject = (project: Project, mode: 'open' | 'focus' = 'focus') => {
    void mode
    actions.openProjectWorkspace(project.id)
    setActiveView(project.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
  }

  const renderProject = (p: Project) => (
    <ProjectNode
      key={p.id}
      project={p}
      isActive={p.id === activeProjectId}
      openPanes={openPaneSets[p.id]}
      onActivate={() => {
        activateProject(p)
      }}
      onToggleCollapsed={() => actions.toggleProjectCollapsed(p.id)}
      onTerminalClick={(t) => {
                                                                             
                                                                           
                                                                           
                                                               
        if (t.gsdSyncViewer) {
          actions.setFullscreenPane(t.id)
          setActiveView('workspace')
          return
        }
        actions.focusWorkspaceTerminal(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        const activeTab = t.tabs.find((tab) => tab.id === t.activeTabId) ?? t.tabs[0]
        if (activeTab?.completionUnread) {
          actions.setSubTabCompletionUnread(p.id, t.id, activeTab.id, false)
        }
        requestPaneFocus(t.id)
        setActiveView(p.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
      }}
      onTerminalDoubleClick={(t) => {
        if (t.gsdSyncViewer) {
          actions.setFullscreenPane(t.id)
          setActiveView('workspace')
          return
        }
        actions.openTerminalWorkspace(p.id, t.id)
        setActiveTerminal(p.id, t.id)
        requestPaneFocus(t.id)
        setActiveView(p.mode === 'agentSandbox' ? 'agentSandbox' : 'workspace')
      }}
      onProjectMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, items: projectMenu(p) })}
      onTerminalMenu={(t, e) =>
        setMenu({ x: e.clientX, y: e.clientY, items: terminalMenu(p.id, t) })
      }
      onAddTerminal={() => openModal('newTerminal', { projectId: p.id })}
      onQuickOpen={() => activateProject(p, 'open')}
      onToggleDisabled={() => {
        const visible = p.terminals.filter((term) => !term.gsdSyncViewer)
        const allDisabled = visible.length > 0 && visible.every((term) => term.disabled)
        actions.setProjectDisabled(p.id, !allDisabled)
      }}
      dropEdge={dropIndicator?.id === `proj:${p.id}` ? dropIndicator.edge : null}
    />
  )

  const ungroupedProjects = ungroupedOrder
    .map((id) => projectsById.get(id))
    .filter((p): p is Project => p !== undefined && !p.archived)

  const groupsByParent = useMemo(() => {
    const map = new Map<string | null, Group[]>()
    const visibleGroups = groups.filter((group) => !group.archived)
    const visibleIds = new Set(visibleGroups.map((group) => group.id))
    for (const g of visibleGroups) {
      // Orphans from an archived/deleted parent remain visible with the root groups.
      const key = g.parentGroupId && visibleIds.has(g.parentGroupId) ? g.parentGroupId : null
      const arr = map.get(key) ?? []
      arr.push(g)
      map.set(key, arr)
    }
    return map
  }, [groups])

  const onGroupOpenAll = (g: Group, mode: 'append' | 'only' = 'append') => {
    actions.openGroupWorkspace(g.id, mode)
    setActiveView('workspace')
  }

  const renderGroup = (g: Group): React.ReactNode => {
    const projectsInGroup = g.projectIds
      .map((id) => projectsById.get(id))
      .filter((p): p is Project => p !== undefined && !p.archived)
    const childGroups = groupsByParent.get(g.id) ?? []
    return (
      <GroupNode
        key={g.id}
        group={g}
        projects={projectsInGroup}
        childGroups={childGroups}
        renderProject={renderProject}
        renderChildGroup={renderGroup}
        onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(g) })}
        onAddProject={() =>
          openModal('newProject', {
            groupId: g.id,
            createTerminalAfterCreate: projectsInGroup.length === 0 && childGroups.length === 0,
          })
        }
        onToggle={() => actions.toggleGroupCollapsed(g.id)}
        onOpenAll={() => onGroupOpenAll(g)}
        onOpenOnly={() => onGroupOpenAll(g, 'only')}
        dragKind={draggingKind}
        reorderEdge={dropIndicator?.id === `grp:${g.id}` ? dropIndicator.edge : null}
        dropInside={dropIndicator?.id === `group:${g.id}`}
      />
    )
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarTabs} role="tablist" aria-label={t('ui.sidebar.navigation')}>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'home'}
          className={`${styles.sidebarTab} ${activeView === 'home' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            if (activeView !== 'home') {
              setActiveView('home')
            }
          }}
          title={t('ui.sidebar.homeTitle', { shortcut: formatShortcut('Ctrl+Shift+H') })}
          aria-label={t('ui.sidebar.home')}
        >
          <Home size={14} />
          <span>{t('ui.sidebar.home')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'projects'}
          aria-label={t('ui.sidebar.projects')}
          title={t('ui.sidebar.projects')}
          className={`${styles.sidebarTab} ${sidebarTab === 'projects' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('projects')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Grid3x3 size={14} />
          <span>{t('ui.sidebar.projects')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={sidebarTab === 'files'}
          aria-label={t('ui.sidebar.files')}
          title={t('ui.sidebar.files')}
          className={`${styles.sidebarTab} ${sidebarTab === 'files' ? styles.sidebarTabActive : ''}`}
          onClick={() => {
            setSidebarTab('files')
            if (!keepHome) setActiveView('workspace')
          }}
        >
          <Folder size={14} />
          <span>{t('ui.sidebar.files')}</span>
        </button>
        {showGitControl && preferences.gitControlPlacement === 'left' ? (
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'git'}
            aria-label={t('ui.sidebar.git')}
            title={t('ui.sidebar.git')}
            className={`${styles.sidebarTab} ${sidebarTab === 'git' ? styles.sidebarTabActive : ''}`}
            onClick={() => {
              setSidebarTab('git')
              if (!keepHome) setActiveView('workspace')
            }}
          >
            <GitBranch size={14} />
            <span>{t('ui.sidebar.git')}</span>
          </button>
        ) : null}
      </div>

      <div className={styles.quickNavList}>
        <button
          type="button"
          className={styles.quickNavItem}
          onClick={() => openModal('findJump')}
          title="Search"
        >
          <Search size={15} className={styles.quickNavIcon} />
          <span>Search</span>
        </button>
      </div>

      {sidebarTab === 'projects' ? (
        <header className={styles.header}>
          <span className={styles.title}>{t('ui.sidebar.projects')}</span>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => openModal('newGroup')}
              title={t('ui.sidebar.newGroupTitle', { shortcut: formatShortcut('Ctrl+Shift+G') })}
              aria-label={t('ui.sidebar.newGroup')}
            >
              <FolderPlus size={14} />
            </button>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={() => openModal('newProject')}
              title={t('ui.sidebar.newProjectTitle', { shortcut: formatShortcut('Ctrl+Shift+P') })}
              aria-label={t('ui.sidebar.newProject')}
            >
              <Plus size={14} />
            </button>
          </div>
        </header>
      ) : null}

      {sidebarTab === 'files' ? (
        <section className={styles.explorerPanel}>
          <div className={styles.explorerHeader}>
            <span className={styles.explorerLabel}>{t('ui.sidebar.explorer')}</span>
            <MoreHorizontal size={14} />
          </div>
          {sidebarTerminal && sidebarSubTab && activeProject ? (
            <FileExplorer
              projectId={activeProject.id}
              cwd={sidebarSubTab.cwd || sidebarTerminal.cwd}
              ptyId={sidebarSubTab.ptyId}
              terminalName={sidebarTerminal.name}
            />
          ) : (
            <div className={styles.explorerEmpty}>
              <EmptyState
                compact
                icon={<FolderPlus size={18} />}
                title={t('ui.sidebar.emptyTitle')}
                description={t('ui.sidebar.emptyDesc')}
                primaryAction={{
                  label: t('ui.sidebar.emptyAction'),
                  onClick: () => openModal('newProject'),
                }}
              />
            </div>
          )}
        </section>
      ) : null}

      {sidebarTab === 'git' ? (
        <section className={styles.explorerPanel}>
          <div className={styles.explorerHeader}>
            <span className={styles.explorerLabel}>{t('ui.sidebar.sourceControl')}</span>
          </div>
          {sidebarTerminal && sidebarSubTab && activeProject ? (
            <GitControl
              projectId={activeProject.id}
              cwd={sidebarSubTab.cwd || sidebarTerminal.cwd}
              ptyId={sidebarSubTab.ptyId}
              terminalName={sidebarTerminal.name}
            />
          ) : (
            <div className={styles.explorerEmpty}>
              <EmptyState
                compact
                icon={<GitBranch size={18} />}
                title={t('git.empty.noTerminal')}
                description={t('git.empty.noTerminalDesc')}
                primaryAction={{
                  label: t('ui.sidebar.emptyAction'),
                  onClick: () => openModal('newProject'),
                }}
              />
            </div>
          )}
        </section>
      ) : null}

      {sidebarTab === 'projects' ? (
        <DndContext
          sensors={sensors}
          collisionDetection={sidebarCollisionDetection}
          onDragStart={({ active }) => {
            setDraggingId(String(active.id))
            setDropIndicator(null)
          }}
          onDragMove={updateDropIndicator}
          onDragOver={updateDropIndicator}
          onDragCancel={clearDragState}
          onDragEnd={onDragEnd}
        >
          <div className={styles.list}>
            {projects.length === 0 && groups.length === 0 ? (
              <div className={styles.emptyWrap}>
                <EmptyState
                  compact
                  icon={<FolderPlus size={18} />}
                  title={t('ui.sidebar.emptyTitle')}
                  description={t('ui.sidebar.emptyDesc')}
                  primaryAction={{
                    label: t('ui.sidebar.emptyAction'),
                    onClick: () => openModal('newProject'),
                  }}
                />
              </div>
            ) : (
              <>
                {(groupsByParent.get(null) ?? []).map(renderGroup)}

                <UngroupedSection
                  projects={ungroupedProjects}
                  renderProject={renderProject}
                  showDropZone={draggingKind === 'project' || draggingKind === 'group'}
                  isDropTarget={dropIndicator?.id === 'group:ungrouped'}
                />
              </>
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingId && draggingLabel ? (
              <div className={styles.dragOverlay}>
                <Folder size={14} />
                <span>{draggingLabel}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}

      {sidebarTab === 'projects' && !keepHome ? <SidebarMergePanel /> : null}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}
      <WorkspaceLayoutFooter />
      <LayoutFooter />
      {preferences.topbarStyle === 'three-areas' ? (
        <div className={styles.systemFooter}>
          <span className={styles.systemFooterLabel}>{t('ui.sidebar.system')}</span>
          <div className={styles.systemFooterActions}>
            {preferences.topbarShowSync ? (
              <button
                type="button"
                className={styles.systemFooterBtn}
                onClick={() => openModal('sync')}
                title={t('sync.title')}
                aria-label={t('sync.title')}
              >
                <RefreshCw size={13} />
              </button>
            ) : null}
            {preferences.topbarShowProfile ? (
              <button
                type="button"
                className={styles.systemFooterBtn}
                onClick={() => openModal('profiles')}
                title={t('profile.manageAccounts')}
                aria-label={t('profile.manageAccounts')}
              >
                <Users size={13} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <SidebarNowPlaying />
      <SidebarUpdate />
      <UserProfile />
    </aside>
  )
}

function UngroupedSection({
  projects,
  renderProject,
  showDropZone = false,
  isDropTarget = false,
}: {
  projects: Project[]
  renderProject: (p: Project) => React.ReactNode
  showDropZone?: boolean
  isDropTarget?: boolean
}) {
  const t = useT()
  const { setNodeRef } = useDroppable({ id: 'group:ungrouped', disabled: !showDropZone })
  if (projects.length === 0 && !showDropZone) return null
  return (
    <div
      ref={setNodeRef}
      className={`${styles.ungroupedSection} ${isDropTarget ? styles.dropInside : ''}`}
    >
      {projects.length === 0 ? (
        <div className={styles.ungroupedEmptyDrop}>{t('ui.sidebar.ungroupedDropArea')}</div>
      ) : null}
      <div className={styles.ungroupedBody}>{projects.map((p) => renderProject(p))}</div>
    </div>
  )
}
