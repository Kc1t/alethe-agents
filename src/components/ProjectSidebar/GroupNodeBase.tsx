import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ChevronDown, Pause, Plus } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { type SidebarDragKind, type SidebarDropEdge } from '../../lib/sidebarDrag'
import { type Group, type Project } from '../../lib/types'
import { Collapse } from '../ui/Collapse'

export type GroupNodeProps = {
  group: Group
  projects: Project[]
  childGroups: Group[]
  renderProject: (project: Project) => React.ReactNode
  renderChildGroup: (group: Group) => React.ReactNode
  onMenu: (event: React.MouseEvent) => void
  onAddProject: () => void
  onToggle: () => void
  onOpenAll?: () => void
  onOpenOnly?: () => void
  dragKind: SidebarDragKind | null
  reorderEdge: SidebarDropEdge | null
  dropInside: boolean
}

type GroupNodeBaseProps = GroupNodeProps & {
  styles: Record<string, string>
  addButtonClass: string
}

export function GroupNodeBase({
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
  styles,
  addButtonClass,
}: GroupNodeBaseProps) {
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
  const setCollapsedRefs = (node: HTMLDivElement | null) => {
    headerDropZone.setNodeRef(node)
    draggable.setNodeRef(node)
  }
  const reorderClass =
    reorderEdge === 'before' ? styles.dropBefore : reorderEdge === 'after' ? styles.dropAfter : ''

  const onTagClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    onToggle()
  }

  return (
    <div
      ref={draggable.setNodeRef}
      className={`${styles.groupBox} ${draggable.isDragging ? styles.dragSource : ''} ${group.suspended ? styles.groupSuspended : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event)
      }}
      style={{ ['--group-color' as string]: group.color }}
    >
      <div
        ref={group.collapsed ? setCollapsedRefs : headerDropZone.setNodeRef}
        className={`${styles.groupTag} ${reorderClass} ${
          dropInside && (group.collapsed || dragKind === 'project') ? styles.dropInside : ''
        }`}
        onClick={onTagClick}
        onDoubleClick={
          onOpenOnly
            ? (event) => {
                event.stopPropagation()
                onOpenOnly()
              }
            : undefined
        }
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
          className={addButtonClass}
          onClick={(event) => {
            event.stopPropagation()
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
          onClick={(event) => {
            event.stopPropagation()
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
          {childGroups.map((childGroup) => renderChildGroup(childGroup))}
          {projects.length === 0 && childGroups.length === 0 ? (
            <div className={styles.groupEmpty}>{t('ui.sidebar.groupEmpty')}</div>
          ) : (
            projects.map((project) => renderProject(project))
          )}
        </div>
      </Collapse>
    </div>
  )
}
