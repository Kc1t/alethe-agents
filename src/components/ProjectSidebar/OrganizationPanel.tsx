import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  Columns2,
  Grid2x2,
  Grid3x3,
  Layout,
  LayoutGrid,
  type LucideIcon,
  PanelLeft,
  Rows2,
  Sidebar as SidebarIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import {
  autoGridLayout,
  cellStyle,
  freeCells,
  gridTrackStyle,
  moveCellTo,
  reconcileGridLayout,
} from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import { createLayoutPresets, type LayoutPresetId } from '../../lib/layoutPresets'
import type { GridLayout, LayoutMode } from '../../lib/types'
import {
  selectActiveContainer,
  selectActiveProject,
  useProjectsStore,
} from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './OrganizationPanel.module.css'

type Scope = 'project' | 'workspace'

const LAYOUTS: { id: LayoutMode; label: string; Icon: LucideIcon }[] = [
  { id: 'auto', label: 'Auto', Icon: LayoutGrid },
  { id: 'spotlight', label: 'Spotlight', Icon: Layout },
  { id: 'sidebar', label: 'Sidebar', Icon: SidebarIcon },
  { id: 'grid', label: 'Grid', Icon: Grid3x3 },
]

const PRESET_ICONS: Partial<Record<LayoutPresetId, LucideIcon>> = {
  columns: Columns2,
  rows: Rows2,
  balanced: Grid2x2,
  'focus-left': PanelLeft,
}

const SIDEBAR_PRESETS: LayoutPresetId[] = ['columns', 'rows', 'balanced', 'focus-left']

export function OrganizationPanel() {
  const t = useT()
  const project = useProjectsStore(selectActiveProject)
  const container = useProjectsStore(selectActiveContainer)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const projects = useProjectsStore((s) => s.projects)
  const workspaceLayout = useProjectsStore((s) => s.preferences.workspaceGridLayout)
  const setLayoutMode = useProjectsStore((s) => s.setLayoutMode)
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)
  const focusWorkspaceTerminal = useProjectsStore((s) => s.focusWorkspaceTerminal)
  const setActiveTerminal = useUiStore((s) => s.setActiveTerminal)
  const requestPaneFocus = useUiStore((s) => s.requestPaneFocus)
  const openModal = useUiStore((s) => s.openModal_)

  const [scope, setScope] = useState<Scope>('project')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const workspaceReady = containers.length >= 2
  const projectReady = Boolean(project && container && container.paneIds.length >= 2)
  const effectiveScope: Scope = scope === 'workspace' && workspaceReady ? 'workspace' : 'project'

  const children = useMemo(() => {
    if (effectiveScope === 'workspace') {
      return containers.map((c) => ({
        id: c.projectId,
        label: projects.find((p) => p.id === c.projectId)?.name ?? c.projectId,
        color: projects.find((p) => p.id === c.projectId)?.color,
      }))
    }
    if (!project || !container) return []
    return container.paneIds
      .map((id) => project.terminals.find((term) => term.id === id))
      .filter((term): term is NonNullable<typeof term> => Boolean(term))
      .map((term) => ({ id: term.id, label: term.name, color: project.color }))
  }, [effectiveScope, containers, projects, project, container])

  const childIds = children.map((child) => child.id)

  const layout = useMemo<GridLayout>(() => {
    const stored = effectiveScope === 'workspace' ? workspaceLayout : project?.gridLayout
    return reconcileGridLayout(stored ?? autoGridLayout(childIds, 2), childIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveScope, workspaceLayout, project?.gridLayout, childIds.join('|')])

  const presets = useMemo(
    () => createLayoutPresets(childIds).filter((preset) => SIDEBAR_PRESETS.includes(preset.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childIds.join('|')],
  )

  if (!projectReady && !workspaceReady) return null

  const persist = (next: GridLayout, recordHistory = false) => {
    if (effectiveScope === 'workspace') {
      setWorkspaceGridLayout(next, recordHistory)
      return
    }
    if (!project) return
    if (project.layoutMode !== 'grid') setLayoutMode(project.id, 'grid')
    setProjectGridLayout(project.id, next, recordHistory)
  }

  const onDragEnd = (event: DragEndEvent) => {
    const id = String(event.active.id).slice('mini:'.length)
    const over = event.over ? String(event.over.id) : ''
    if (!over) return
    const target = over.startsWith('minislot:')
      ? (() => {
          const [, col, row] = over.split(':')
          return { col: Number(col), row: Number(row) }
        })()
      : layout.cells[over.slice('mini:'.length)]
    if (!target) return
    persist(moveCellTo(layout, childIds, id, target.col, target.row))
  }

  const focusChild = (id: string) => {
    if (effectiveScope === 'workspace') return
    if (!project) return
    focusWorkspaceTerminal(project.id, id)
    setActiveTerminal(project.id, id)
    requestPaneFocus(id)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.label}>{t('ui.sidebar.organization')}</span>
        {workspaceReady && projectReady ? (
          <div className={styles.scopeSwitch}>
            <button
              type="button"
              className={`${styles.scopeBtn} ${effectiveScope === 'project' ? styles.scopeBtnActive : ''}`}
              onClick={() => setScope('project')}
            >
              {t('ui.sidebar.scopeProject')}
            </button>
            <button
              type="button"
              className={`${styles.scopeBtn} ${effectiveScope === 'workspace' ? styles.scopeBtnActive : ''}`}
              onClick={() => setScope('workspace')}
            >
              {t('ui.sidebar.scopeWorkspace')}
            </button>
          </div>
        ) : null}
      </div>

      {effectiveScope === 'project' && project && container ? (
        <div className={styles.modeSwitch}>
          {LAYOUTS.map((opt) => {
            const Icon = opt.Icon
            const active = container.internalLayout === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                className={`${styles.modeBtn} ${active ? styles.modeBtnActive : ''}`}
                onClick={() => setLayoutMode(project.id, opt.id)}
                title={opt.label}
                aria-label={opt.label}
              >
                <Icon size={13} />
              </button>
            )
          })}
        </div>
      ) : null}

      <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={onDragEnd}>
        <div
          className={styles.map}
          style={gridTrackStyle(layout)}
          title={t('ui.sidebar.miniMapHint')}
        >
          {freeCells(layout, childIds).map((slot) => (
            <MiniSlot key={`s-${slot.col}-${slot.row}`} col={slot.col} row={slot.row} />
          ))}
          {children.map((child) => {
            const cell = layout.cells[child.id]
            if (!cell) return null
            return (
              <MiniCell
                key={child.id}
                id={child.id}
                label={child.label}
                color={child.color}
                style={cellStyle(cell)}
                onActivate={() => focusChild(child.id)}
              />
            )
          })}
        </div>
      </DndContext>

      <div className={styles.actions}>
        <div className={styles.presets}>
          {presets.map((preset) => {
            const Icon = PRESET_ICONS[preset.id] ?? LayoutGrid
            return (
              <button
                key={preset.id}
                type="button"
                className={styles.presetBtn}
                onClick={() => persist(reconcileGridLayout(preset.layout, childIds), true)}
                title={t(preset.label)}
                aria-label={t(preset.label)}
              >
                <Icon size={13} />
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className={styles.designBtn}
          onClick={() =>
            openModal(
              'layoutDesigner',
              effectiveScope === 'workspace'
                ? { kind: 'workspace' }
                : { kind: 'project', id: project?.id },
            )
          }
          title={t('ui.sidebar.designWorkspaceLayout')}
        >
          <Grid3x3 size={12} />
          <span>{t('ui.sidebar.editGrid')}</span>
        </button>
      </div>
    </div>
  )
}

function MiniSlot({ col, row }: { col: number; row: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `minislot:${col}:${row}` })
  return (
    <div
      ref={setNodeRef}
      className={`${styles.slot} ${isOver ? styles.slotOver : ''}`}
      style={{ gridColumn: col, gridRow: row }}
    />
  )
}

function MiniCell({
  id,
  label,
  color,
  style,
  onActivate,
}: {
  id: string
  label: string
  color?: string
  style: React.CSSProperties
  onActivate: () => void
}) {
  const draggable = useDraggable({ id: `mini:${id}` })
  const droppable = useDroppable({ id: `mini:${id}` })
  const setRefs = (node: HTMLButtonElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  return (
    <button
      ref={setRefs}
      type="button"
      className={`${styles.cell} ${draggable.isDragging ? styles.cellDragging : ''} ${
        droppable.isOver && !draggable.isDragging ? styles.cellOver : ''
      }`}
      style={{ ...style, ['--cell-accent' as string]: color || 'var(--border-strong)' }}
      onClick={onActivate}
      title={label}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      <span className={styles.cellLabel}>{label}</span>
    </button>
  )
}
