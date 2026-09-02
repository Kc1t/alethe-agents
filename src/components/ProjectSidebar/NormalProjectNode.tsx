import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  AlertCircle,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Network,
  Pause,
  Plus,
} from 'lucide-react'

import { useT } from '../../lib/i18n'
import { useChangeTriggerStore } from '../../stores/changeTriggerStore'
import { type SidebarDropEdge } from '../../lib/sidebarDrag'
import { type Project, type Terminal } from '../../lib/types'
import { Collapse } from '../ui/Collapse'
import { DotmCircular2 } from '../ui/dotm-circular-2'
import styles from './NormalProjectSidebar.module.css'
import { NormalTerminalNode } from './NormalTerminalNode'
import { useProjectNodeState } from './sidebarController'

export type NormalProjectNodeProps = {
  project: Project
  isActive: boolean
  openPanes: Set<string> | undefined
  onActivate: () => void
  onToggleCollapsed: () => void
  onTerminalClick: (t: Terminal) => void
  onTerminalDoubleClick: (t: Terminal) => void
  onProjectMenu: (e: React.MouseEvent) => void
  onTerminalMenu: (t: Terminal, e: React.MouseEvent) => void
  onAddTerminal: () => void
  onQuickOpen: () => void
  onToggleDisabled: () => void
  dropEdge: SidebarDropEdge | null
}

export function NormalProjectNode({
  project,
  isActive,
  openPanes,
  onActivate,
  onToggleCollapsed,
  onTerminalClick,
  onTerminalDoubleClick,
  onProjectMenu,
  onTerminalMenu,
  onAddTerminal,
  dropEdge,
}: NormalProjectNodeProps) {
  const t = useT()
  const pendingChange = useChangeTriggerStore((state) => state.pending[project.id])
  const openChangeTrigger = useChangeTriggerStore((state) => state.open)
  const { setNodeRef: dropRef } = useDroppable({ id: `proj:${project.id}` })
  const draggable = useDraggable({ id: `proj:${project.id}` })
  const isDragging = draggable.isDragging
  const setRowRefs = (node: HTMLDivElement | null) => {
    dropRef(node)
    draggable.setNodeRef(node)
  }
  const dropClass =
    dropEdge === 'before'
      ? styles.dropBefore
      : dropEdge === 'after'
        ? styles.dropAfter
        : dropEdge === 'inside'
          ? styles.dropInside
          : ''

  const { allDisabled, focusedTerminalId, isEmpty, runningCount, visibleTerminals } =
    useProjectNodeState(project)

  return (
    <div className={`${styles.projectNode} ${allDisabled ? styles.projectDisabled : ''}`}>
      <div
        ref={setRowRefs}
        className={`${styles.projectRow} ${isActive ? styles.projectRowActive : ''} ${
          isDragging ? styles.dragSource : ''
        } ${dropClass}`}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onProjectMenu(e)
        }}
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <span className={styles.projectLead}>
          {project.iconUrl ? (
            <img src={project.iconUrl} alt="" className={styles.projectIcon} />
          ) : (
            <Folder
              size={16}
              className={styles.projectFolderIcon}
              style={project.color ? { color: project.color } : undefined}
            />
          )}
        </span>
        <span className={styles.projectName} title={project.name}>
          {project.name}
        </span>
        {project.mode === 'agentSandbox' ? (
          <Network size={12} className={styles.agentProjectIcon} />
        ) : null}
        {allDisabled ? <Pause size={11} className={styles.projectPauseIcon} /> : null}
        {pendingChange ? (
          <button
            type="button"
            className={styles.changeTriggerBadge}
            onClick={(e) => {
              e.stopPropagation()
              openChangeTrigger(project.id)
            }}
            title={t('changeTrigger.badgeTooltip', { count: pendingChange.fileCount })}
            aria-label={t('changeTrigger.badgeTooltip', { count: pendingChange.fileCount })}
          >
            <AlertCircle size={12} />
          </button>
        ) : null}
        <button
          type="button"
          className={`${styles.rowHoverBtn} ${isEmpty ? styles.rowHoverBtnVisible : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onAddTerminal()
          }}
          title={t('ui.sidebar.newTerminal')}
          aria-label={t('ui.sidebar.newTerminal')}
        >
          <Plus size={15} />
        </button>
        <span className={`${styles.rowEndSlot} ${runningCount > 0 ? styles.rowEndSlotActive : ''}`}>
          {runningCount > 0 ? (
            <DotmCircular2
              size={14}
              dotSize={2}
              cellPadding={1}
              speed={1.2}
              bloom
              ariaLabel={t('ui.terminal.working')}
              className={`${styles.rosterLoading} ${styles.rowStatusIndicator}`}
            />
          ) : null}
          <button
            type="button"
            className={`${styles.rowHoverBtn} ${styles.rowEndAction}`}
            onClick={(e) => {
              e.stopPropagation()
              onProjectMenu(e)
            }}
            title={t('ui.sidebar.moreActions')}
            aria-label={t('ui.sidebar.moreActions')}
          >
            <MoreHorizontal size={14} />
          </button>
        </span>
        {!isEmpty ? (
          <button
            type="button"
            className={styles.rowChevronBtn}
            onClick={(e) => {
              e.stopPropagation()
              onToggleCollapsed()
            }}
            aria-label={project.collapsed ? t('ui.sidebar.expand') : t('ui.sidebar.collapse')}
            aria-expanded={!project.collapsed}
          >
            <ChevronDown
              size={15}
              className={`${styles.disclosureChevron} ${project.collapsed ? styles.disclosureClosed : ''}`}
            />
          </button>
        ) : null}
      </div>

      <Collapse open={!project.collapsed && visibleTerminals.length > 0}>
        {visibleTerminals.map((term) => (
          <NormalTerminalNode
            key={term.id}
            project={project}
            terminal={term}
            selected={openPanes?.has(term.id) ?? false}
            focused={focusedTerminalId === term.id}
            onClick={() => onTerminalClick(term)}
            onDoubleClick={() => onTerminalDoubleClick(term)}
            onMenu={(e) => onTerminalMenu(term, e)}
          />
        ))}
      </Collapse>
    </div>
  )
}
