import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import * as Dialog from '@radix-ui/react-dialog'
import { Clock3, LayoutGrid, Minus, Plus, X } from 'lucide-react'
import { memo, useMemo, useState } from 'react'

import {
  autoGridLayout,
  freeCells,
  gridTrackStyle,
  moveCellTo,
  reconcileGridLayout,
} from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import { createLayoutPresets } from '../../lib/layoutPresets'
import type { GridCell, GridLayout, GridLayoutHistoryEntry } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { GridCellHandles } from '../GridCellHandles'
import controls from './controls.module.css'
import styles from './LayoutDesignerModal.module.css'

type DesignerChild = {
  id: string
  label: string
  color?: string

  hint?: string
}

type Context =
  { kind: 'project'; id: string } | { kind: 'group'; id: string } | { kind: 'workspace' }

export function LayoutDesignerModal() {
  const open = useUiStore((s) => s.openModal === 'layoutDesigner')
  const context = useUiStore((s) => s.modalContext) as Context | null
  const closeModal = useUiStore((s) => s.closeModal)

  if (!open || !context) return null
  const k = context.kind === 'workspace' ? 'workspace' : `${context.kind}:${context.id}`
  return <DesignerInner key={k} context={context} onClose={closeModal} />
}

/** Reconciles a draft and guarantees explicit track sizes, which the edge handles rely on. */
function normalizeDraft(layout: GridLayout, childIds: string[]): GridLayout {
  const next = reconcileGridLayout(layout, childIds)
  return {
    ...next,
    colSizes: next.colSizes ?? Array(next.cols).fill(1),
    rowSizes: next.rowSizes ?? Array(next.rows).fill(1),
  }
}

function resizeTracks(sizes: number[] | undefined, count: number): number[] {
  const current = sizes ?? []
  if (current.length === count) return current
  if (current.length < count) return [...current, ...Array(count - current.length).fill(1)]
  return current.slice(0, count)
}

function DesignerInner({ context, onClose }: { context: Context; onClose: () => void }) {
  const t = useT()
  const project = useProjectsStore((s) =>
    context.kind === 'project' ? s.projects.find((p) => p.id === context.id) : null,
  )
  const group = useProjectsStore((s) =>
    context.kind === 'group' ? s.groups.find((g) => g.id === context.id) : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const workspaceLayout = useProjectsStore((s) => s.preferences.workspaceGridLayout)
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const setGroupGridLayout = useProjectsStore((s) => s.setGroupGridLayout)
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)

  const [title, children, currentLayout, history] = useMemo<
    [string, DesignerChild[], GridLayout | undefined, GridLayoutHistoryEntry[]]
  >(() => {
    if (context.kind === 'project' && project) {
      return [
        t('mod.layoutTitleProject', { name: project.name }),
        project.terminals.map((term) => ({
          id: term.id,
          label: term.name,
          color: project.color,
          hint: term.tabs[0]?.type ?? 'shell',
        })),
        project.gridLayout,
        project.gridLayoutHistory ?? [],
      ]
    }
    if (context.kind === 'group' && group) {
      const groupProjects = group.projectIds
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
      return [
        t('mod.layoutTitleGroup', { name: group.name }),
        groupProjects.map((p) => ({
          id: p.id,
          label: p.name,
          color: p.color,
          hint: t('mod.terminalCount', { count: p.terminals.length }),
        })),
        group.gridLayout,
        group.gridLayoutHistory ?? [],
      ]
    }
    if (context.kind === 'workspace') {
      const openProjects = containers
        .map((c) => projects.find((p) => p.id === c.projectId))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
      return [
        t('mod.layoutTitleWorkspace'),
        openProjects.map((p) => ({
          id: p.id,
          label: p.name,
          color: p.color,
          hint: t('mod.terminalCount', { count: p.terminals.length }),
        })),
        workspaceLayout,
        useProjectsStore.getState().preferences.workspaceGridLayoutHistory ?? [],
      ]
    }
    return [t('mod.layoutTitleFallback'), [], undefined, []]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, project, group, projects, containers, workspaceLayout])

  const childIds = children.map((c) => c.id)

  const [draft, setDraft] = useState<GridLayout>(() =>
    normalizeDraft(currentLayout ?? autoGridLayout(childIds, 2), childIds),
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const applyDraft = (next: GridLayout) => {
    setDraft(normalizeDraft(next, childIds))
    setSelected(null)
  }

  const setDimensions = (cols: number, rows: number) => {
    setDraft((prev) =>
      normalizeDraft(
        {
          ...prev,
          cols,
          rows,
          colSizes: resizeTracks(prev.colSizes, cols),
          rowSizes: resizeTracks(prev.rowSizes, rows),
        },
        childIds,
      ),
    )
  }

  const resetAuto = () => applyDraft(autoGridLayout(childIds, draft.cols))

  const presets = useMemo(
    () => createLayoutPresets(childIds),
    // The modal is remounted for each context and child IDs are stable during editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [childIds.join('|')],
  )

  const onDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id).slice('box:'.length)
    setDragging(id)
    setSelected(id)
  }

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const id = String(event.active.id).slice('box:'.length)
    const over = event.over ? String(event.over.id) : ''
    if (!over) return
    const target = over.startsWith('slot:')
      ? (() => {
          const [, col, row] = over.split(':')
          return { col: Number(col), row: Number(row) }
        })()
      : over.startsWith('box:')
        ? draft.cells[over.slice('box:'.length)]
        : null
    if (!target) return
    setDraft((prev) => moveCellTo(prev, childIds, id, target.col, target.row))
  }

  const save = () => {
    const layout = reconcileGridLayout(draft, childIds)
    if (context.kind === 'project') setProjectGridLayout(context.id, layout, true)
    else if (context.kind === 'group') setGroupGridLayout(context.id, layout, true)
    else setWorkspaceGridLayout(layout, true)
    onClose()
  }

  const clearWorkspace =
    context.kind === 'workspace' && workspaceLayout
      ? () => {
          setWorkspaceGridLayout(null)
          onClose()
        }
      : null

  const draggingChild = dragging ? children.find((child) => child.id === dragging) : null

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onEscapeKeyDown={onClose}
        >
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <button
              type="button"
              className={styles.closeBtn}
              aria-label={t('mod.close')}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </header>

          <div className={styles.toolbar}>
            <Stepper
              label="cols"
              value={draft.cols}
              onDec={() => setDimensions(Math.max(1, draft.cols - 1), draft.rows)}
              onInc={() => setDimensions(Math.min(8, draft.cols + 1), draft.rows)}
            />
            <Stepper
              label="rows"
              value={draft.rows}
              onDec={() => setDimensions(draft.cols, Math.max(1, draft.rows - 1))}
              onInc={() => setDimensions(draft.cols, Math.min(8, draft.rows + 1))}
            />
            <button type="button" className={controls.btn} onClick={resetAuto}>
              {t('mod.autoArrange')}
            </button>
            <span className={styles.hint}>{t('mod.layoutHint')}</span>
          </div>

          <div className={styles.designerBody}>
            <aside className={styles.library} aria-label={t('mod.layoutLibrary')}>
              <div className={styles.libraryHeading}>
                <LayoutGrid size={13} />
                <span>{t('mod.layoutPresets')}</span>
              </div>
              <div className={styles.libraryList}>
                {presets.map((preset) => (
                  <button
                    type="button"
                    className={styles.libraryItem}
                    key={preset.id}
                    onClick={() => applyDraft(preset.layout)}
                  >
                    <span>{t(preset.label)}</span>
                    <span className={styles.libraryMeta}>
                      {preset.layout.cols}×{preset.layout.rows}
                    </span>
                  </button>
                ))}
              </div>
              <div className={styles.libraryHeading}>
                <Clock3 size={13} />
                <span>{t('mod.layoutRecent')}</span>
              </div>
              {history.length ? (
                <div className={styles.libraryList}>
                  {history.map((entry) => (
                    <button
                      type="button"
                      className={styles.libraryItem}
                      key={entry.id}
                      onClick={() => applyDraft(entry.layout)}
                    >
                      <span>{new Date(entry.savedAt).toLocaleString()}</span>
                      <span className={styles.libraryMeta}>
                        {entry.layout.cols}×{entry.layout.rows}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className={styles.libraryEmpty}>{t('mod.layoutRecentEmpty')}</p>
              )}
            </aside>

            <DndContext
              sensors={sensors}
              collisionDetection={pointerWithin}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={() => setDragging(null)}
            >
              <div className={styles.canvas} style={gridTrackStyle(draft)}>
                {freeCells(draft, childIds).map((slot) => (
                  <DesignerSlot
                    key={`slot-${slot.col}-${slot.row}`}
                    col={slot.col}
                    row={slot.row}
                  />
                ))}
                {children.map((child) => {
                  const cell = draft.cells[child.id]
                  if (!cell) return null
                  return (
                    <DesignerBox
                      key={child.id}
                      child={child}
                      cell={cell}
                      childIds={childIds}
                      layout={draft}
                      selected={selected === child.id}
                      dragging={dragging === child.id}
                      onSelect={setSelected}
                      onUpdate={setDraft}
                    />
                  )
                })}
              </div>
              <DragOverlay dropAnimation={null}>
                {draggingChild ? (
                  <div className={`${styles.box} ${styles.boxOverlay}`}>
                    <div className={styles.boxHeader}>
                      {draggingChild.color ? (
                        <span
                          className={styles.colorChip}
                          style={{ background: draggingChild.color }}
                        />
                      ) : null}
                      <span className={styles.boxLabel}>{draggingChild.label}</span>
                    </div>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          <footer className={styles.footer}>
            {clearWorkspace ? (
              <button
                type="button"
                className={controls.btn}
                onClick={clearWorkspace}
                style={{ marginRight: 'auto' }}
              >
                {t('mod.removeCustomLayout')}
              </button>
            ) : null}
            <button type="button" className={controls.btn} onClick={onClose}>
              {t('mod.cancel')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={save}
            >
              {t('mod.saveLayout')}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function DesignerSlot({ col, row }: { col: number; row: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${col}:${row}` })
  return (
    <div
      ref={setNodeRef}
      className={`${styles.slot} ${isOver ? styles.slotActive : ''}`}
      style={{ gridColumn: col, gridRow: row }}
    />
  )
}

const DesignerBox = memo(function DesignerBox({
  child,
  cell,
  childIds,
  layout,
  selected,
  dragging,
  onSelect,
  onUpdate,
}: {
  child: DesignerChild
  cell: GridCell
  childIds: string[]
  layout: GridLayout
  selected: boolean
  dragging: boolean
  onSelect: (id: string | null) => void
  onUpdate: (layout: GridLayout) => void
}) {
  const draggable = useDraggable({ id: `box:${child.id}` })
  const droppable = useDroppable({ id: `box:${child.id}` })
  const setRefs = (node: HTMLDivElement | null) => {
    draggable.setNodeRef(node)
    droppable.setNodeRef(node)
  }
  return (
    <div
      ref={setRefs}
      className={`${styles.box} ${selected ? styles.boxSelected : ''} ${
        dragging ? styles.boxDragging : ''
      } ${droppable.isOver && !dragging ? styles.boxDropTarget : ''}`}
      style={{
        gridColumn: `${cell.col} / span ${cell.colSpan}`,
        gridRow: `${cell.row} / span ${cell.rowSpan}`,
      }}
      onClick={() => onSelect(selected ? null : child.id)}
      {...draggable.attributes}
      {...draggable.listeners}
    >
      <div className={styles.boxHeader}>
        {child.color ? (
          <span className={styles.colorChip} style={{ background: child.color }} />
        ) : null}
        <span className={styles.boxLabel}>{child.label}</span>
        <span className={styles.boxSpanBadge}>
          {cell.colSpan}×{cell.rowSpan}
        </span>
      </div>
      {child.hint ? <div className={styles.boxHint}>{child.hint}</div> : null}
      <GridCellHandles
        cellId={child.id}
        childIds={childIds}
        layout={layout}
        onUpdate={onUpdate}
        edges={['left', 'right', 'top', 'bottom']}
      />
    </div>
  )
})

function Stepper({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string
  value: number
  onDec: () => void
  onInc: () => void
}) {
  const t = useT()
  return (
    <div className={styles.stepper}>
      <span className={styles.stepperLabel}>{label}</span>
      <button
        type="button"
        className={styles.stepperBtn}
        onClick={onDec}
        aria-label={t('mod.decrease', { label })}
      >
        <Minus size={12} />
      </button>
      <span className={styles.stepperValue}>{value}</span>
      <button
        type="button"
        className={styles.stepperBtn}
        onClick={onInc}
        aria-label={t('mod.increase', { label })}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
