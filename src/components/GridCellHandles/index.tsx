import { Expand } from 'lucide-react'

import { useGridCellDrag } from '../../hooks/useGridCellDrag'
import { fillFreeSpace, type GridEdge } from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import type { GridLayout } from '../../lib/types'
import styles from './GridCellHandles.module.css'

/**
 * Every internal boundary of the grid is already covered by the right/bottom handles of the
 * cell above/left of it, so panes only expose those two and keep their headers clickable.
 */
const DEFAULT_EDGES: GridEdge[] = ['right', 'bottom']

export type GridCellHandlesProps = {
  cellId: string
  childIds: string[]
  layout: GridLayout | null
  onUpdate: (layout: GridLayout) => void
  edges?: GridEdge[]
}

export function GridCellHandles({
  cellId,
  childIds,
  layout,
  onUpdate,
  edges = DEFAULT_EDGES,
}: GridCellHandlesProps) {
  const t = useT()
  const { onPointerDown, onDoubleClick, canDrag } = useGridCellDrag({
    cellId,
    childIds,
    layout,
    onUpdate,
  })
  if (!layout?.cells[cellId]) return null

  const canFill = fillFreeSpace(layout, childIds, cellId) !== layout

  return (
    <>
      {edges.map((edge) =>
        canDrag(edge) ? (
          <div
            key={edge}
            className={`${styles.handle} ${styles[edge]}`}
            onPointerDown={onPointerDown(edge)}
            onDoubleClick={onDoubleClick}
            title={t('ws.dragEdgeHint')}
            aria-hidden
          />
        ) : null,
      )}
      {canFill ? (
        <button
          type="button"
          className={styles.fillBtn}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onUpdate(fillFreeSpace(layout, childIds, cellId))
          }}
          title={t('ws.fillFreeSpace')}
          aria-label={t('ws.fillFreeSpace')}
        >
          <Expand size={11} />
        </button>
      ) : null}
    </>
  )
}
