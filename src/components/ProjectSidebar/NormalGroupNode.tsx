import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ChevronDown, Pause, Plus } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { type SidebarDragKind, type SidebarDropEdge } from '../../lib/sidebarDrag'
import { type Group, type Project } from '../../lib/types'
import { Collapse } from '../ui/Collapse'
import styles from './NormalProjectSidebar.module.css'

                                                                          
export function collectDescendants(rootId: string, allGroups: Group[]): Set<string> {
  const result = new Set<string>()
  const queue = [rootId]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const g of allGroups) {
      if (g.parentGroupId === cur && !result.has(g.id)) {
        result.add(g.id)
        queue.push(g.id)
      }
    }
  }
  return result
}

export type NormalGroupNodeProps = {
  group: Group
  projects: Project[]
  childGroups: Group[]
  renderProject: (p: Project) => React.ReactNode
  renderChildGroup: (g: Group) => React.ReactNode
  onMenu: (e: React.MouseEvent) => void
  onAddProject: () => void
  onToggle: () => void
  onOpenAll: () => void
  onOpenOnly: () => void
  dragKind: SidebarDragKind | null
  reorderEdge: SidebarDropEdge | null
  dropInside: boolean
}

export function NormalGroupNode({
  group,
  projects,
  childGroups,
  renderProject,
  renderChildGroup,
  onMenu,
  onAddProject,
  onToggle,
  onOpenOnly,
  dragKind,
  reorderEdge,
  dropInside,
}: NormalGroupNodeProps) {
  const t = useT()
  const headerDropZone = useDroppable({
    id: dragKind === 'group' ? `grp:${group.id}` : `group:${group.id}`,
    disabled: dragKind !== 'group' && dragKind !== 'project',
  })
  const bodyDropZone = useDroppable({
    id: dragKind === 'group' ? `group:${group.id}` : `group-body:${group.id}`,
    disabled: dragKind !== 'group' || group.collapsed,
  })
  const draggable = useDraggable({ id: `grp:${group.id}` })
  const isDragging = draggable.isDragging
  const setCollapsedRefs = (node: HTMLDivElement | null) => {
    headerDropZone.setNodeRef(node)
    draggable.setNodeRef(node)
  }
  const reorderClass =
    reorderEdge === 'before' ? styles.dropBefore : reorderEdge === 'after' ? styles.dropAfter : ''

  const onTagClick = (e: React.MouseEvent) => {
    const tgt = e.target as HTMLElement
    if (tgt.closest('button')) return // chevron/+ tratam o próprio click
    onToggle()
  }

  return (
    <div
      ref={draggable.setNodeRef}
      className={`${styles.groupBox} ${isDragging ? styles.dragSource : ''} ${group.suspended ? styles.groupSuspended : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e)
      }}
      style={{ ['--group-color' as string]: group.color }}
    >
      <div
        ref={group.collapsed ? setCollapsedRefs : headerDropZone.setNodeRef}
        className={`${styles.groupTag} ${reorderClass} ${
          dropInside && (group.collapsed || dragKind === 'project') ? styles.dropInside : ''
        }`}
        onClick={onTagClick}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onOpenOnly()
        }}
        title={
          group.suspended
            ? t('ui.sidebar.groupSuspendedHint')
            : t('ui.sidebar.openAllGroupProjects')
        }
        {...draggable.attributes}
        {...draggable.listeners}
      >
        <span className={styles.groupTagName}>{group.name}</span>
        {group.suspended && <Pause size={10} className={styles.groupSuspendedIcon} />}
        <span className={styles.groupRule} />
        <button
          type="button"
          className={styles.groupAddBtn}
          onClick={(e) => {
            e.stopPropagation()
            onAddProject()
          }}
          title={t('ui.sidebar.newProjectInGroup')}
          aria-label={t('ui.sidebar.newProjectInGroup')}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className={styles.groupChevronBtn}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          aria-label={t('ui.sidebar.collapse')}
        >
          <ChevronDown
            size={14}
            className={`${styles.disclosureChevron} ${group.collapsed ? styles.disclosureClosed : ''}`}
          />
        </button>
      </div>
      <Collapse open={!group.collapsed}>
        <div
          ref={bodyDropZone.setNodeRef}
          className={`${styles.groupBody} ${dragKind === 'group' && dropInside ? styles.dropInside : ''}`}
        >
          {childGroups.map((cg) => renderChildGroup(cg))}
          {projects.length === 0 && childGroups.length === 0 ? (
            <div className={styles.groupEmpty}>{t('ui.sidebar.groupEmpty')}</div>
          ) : (
            projects.map((p) => renderProject(p))
          )}
        </div>
      </Collapse>
    </div>
  )
}
