import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ChevronDown, Folder, MoreHorizontal, Pause, Plus } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { type SidebarDropEdge } from '../../lib/sidebarDrag'
import { type Project, type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { Collapse } from '../ui/Collapse'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './ProjectSidebar.module.css'
import { TerminalNode } from './TerminalNode'

export type ProjectNodeProps = {
  project: Project
  isActive: boolean
  openPanes: Set<string> | undefined
  onActivate: () => void
  onTerminalClick: (terminal: Terminal) => void
  onTerminalDoubleClick: (terminal: Terminal) => void
  onAddTerminal: () => void
  onProjectMenu: (event: React.MouseEvent) => void
  onTerminalMenu: (terminal: Terminal, event: React.MouseEvent) => void
  dropEdge: SidebarDropEdge | null
}

function ProjectVisual({ project }: { project: Project }) {
  return project.iconUrl ? (
    <img className={styles.projectLogo} src={project.iconUrl} alt="" />
  ) : (
    <Folder size={13} className={styles.projectFolderIcon} aria-hidden />
  )
}

export function ProjectNode({
  project,
  isActive,
  openPanes,
  onActivate,
  onTerminalClick,
  onTerminalDoubleClick,
  onAddTerminal,
  onProjectMenu,
  onTerminalMenu,
  dropEdge,
}: ProjectNodeProps) {
  const t = useT()
  const { setNodeRef: dropRef } = useDroppable({ id: `proj:${project.id}` })
  const draggable = useDraggable({ id: `proj:${project.id}` })
  const toggleCollapsed = useProjectsStore((state) => state.toggleProjectCollapsed)
  const visibleTerminals = project.terminals.filter((terminal) => !terminal.gsdSyncViewer)
  const isEmpty = visibleTerminals.length === 0
  const allDisabled = visibleTerminals.length > 0 && visibleTerminals.every((term) => term.disabled)
  const runningCount = useTerminalsStore((state) =>
    visibleTerminals.reduce(
      (count, terminal) =>
        count +
        (terminal.tabs.some((tab) => tab.ptyId && state.byPtyId[tab.ptyId]?.status === 'working')
          ? 1
          : 0),
      0,
    ),
  )
  const expanded = !project.collapsed
  const focusedTerminalId = useUiStore((state) =>
    state.activeTerminal?.projectId === project.id ? state.activeTerminal.terminalId : undefined,
  )
  const dropClass =
    dropEdge === 'before'
      ? styles.dropBefore
      : dropEdge === 'after'
        ? styles.dropAfter
        : dropEdge === 'inside'
          ? styles.dropInside
          : ''

  return (
    <div
      ref={draggable.setNodeRef}
      className={`${styles.projectNode} ${draggable.isDragging ? styles.dragSource : ''} ${
        allDisabled ? styles.projectDisabled : ''
      }`}
      style={{ ['--project-color' as string]: project.color || 'var(--border-strong)' }}
    >
      <div
        ref={dropRef}
        className={`${styles.projectRow} ${isActive ? styles.projectActive : ''} ${dropClass}`}
        onClick={() => {
          if (!isEmpty && !expanded) toggleCollapsed(project.id)
          onActivate()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onProjectMenu(event)
        }}
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <ProjectVisual project={project} />
        <span className={styles.projectName} title={project.name}>
          <span className={styles.projectNameText}>{project.name}</span>
        </span>
        {allDisabled ? <Pause size={10} className={styles.projectPauseIcon} /> : null}
        <button
          type="button"
          className={`${styles.projectAddTerminalButton} ${isEmpty ? styles.projectAddTerminalButtonVisible : ''}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onAddTerminal()
          }}
          title={t('ui.sidebar.newTerminalHere')}
          aria-label={t('ui.sidebar.newTerminalHere')}
        >
          <Plus size={12} />
        </button>
        <span className={`${styles.rowEndSlot} ${runningCount > 0 ? styles.rowEndSlotActive : ''}`}>
          {runningCount > 0 ? (
            <DotmCircular2
              size={13}
              dotSize={2}
              cellPadding={1}
              speed={1.2}
              bloom
              ariaLabel={t('ui.terminal.working')}
              className={`${styles.terminalLoading} ${styles.rowStatusIndicator}`}
            />
          ) : null}
          <button
            type="button"
            className={`${styles.rowMenuBtn} ${styles.rowEndAction}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onProjectMenu(event)
            }}
            title={t('ui.sidebar.moreActions')}
            aria-label={t('ui.sidebar.moreActions')}
          >
            <MoreHorizontal size={13} />
          </button>
        </span>
        {!isEmpty ? (
          <button
            type="button"
            className={styles.projectChevronBtn}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleCollapsed(project.id)
            }}
            title={expanded ? t('ui.sidebar.collapse') : t('ui.sidebar.expand')}
            aria-label={expanded ? t('ui.sidebar.collapse') : t('ui.sidebar.expand')}
            aria-expanded={expanded}
          >
            <ChevronDown
              size={13}
              className={`${styles.disclosureChevron} ${expanded ? '' : styles.disclosureClosed}`}
            />
          </button>
        ) : null}
      </div>

      <Collapse open={expanded && visibleTerminals.length > 0}>
        <div className={styles.terminals}>
          {visibleTerminals.map((terminal) => (
            <TerminalNode
              key={terminal.id}
              project={project}
              terminal={terminal}
              selected={openPanes?.has(terminal.id) ?? false}
              focused={focusedTerminalId === terminal.id}
              onClick={() => onTerminalClick(terminal)}
              onDoubleClick={() => onTerminalDoubleClick(terminal)}
              onMenu={(event) => onTerminalMenu(terminal, event)}
            />
          ))}
        </div>
      </Collapse>
    </div>
  )
}
