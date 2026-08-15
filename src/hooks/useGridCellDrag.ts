import type React from 'react'
import { useEffect, useRef } from 'react'

import { expandCell, fillFreeSpace, freeSpanFor, type GridEdge } from '../lib/gridLayout'
import type { GridLayout } from '../lib/types'

export type GridCellDragOptions = {
  cellId: string
  childIds: string[]
  layout: GridLayout | null
  onUpdate: (layout: GridLayout) => void
}

const MIN_FR = 0.1

type TrackGeometry = { sizes: number[]; gap: number; offset: number; extent: number }

function trackGeometry(gridEl: HTMLElement, horizontal: boolean): TrackGeometry {
  const computed = getComputedStyle(gridEl)
  const raw = horizontal ? computed.gridTemplateColumns : computed.gridTemplateRows
  const sizes = raw
    .split(' ')
    .map((part) => Number.parseFloat(part))
    .filter((value) => Number.isFinite(value))
  const gap = Number.parseFloat(horizontal ? computed.columnGap : computed.rowGap) || 0
  const offset = Number.parseFloat(horizontal ? computed.paddingLeft : computed.paddingTop) || 0
  const extent = sizes.reduce((a, b) => a + b, 0)
  return { sizes, gap, offset, extent }
}

/** 1-based track index under `position`, measured from the grid's border box. */
function trackAt({ sizes, gap, offset }: TrackGeometry, position: number): number {
  let acc = offset
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i] + (i < sizes.length - 1 ? gap : 0)
    if (position <= acc) return i + 1
  }
  return sizes.length
}

function closestGrid(node: HTMLElement | null): HTMLElement | null {
  let current = node?.parentElement ?? null
  while (current && getComputedStyle(current).display !== 'grid') {
    current = current.parentElement
  }
  return current
}

/**
 * Edge dragging for a cell of a `GridLayout`.
 *
 * When there is free space past the edge — or the cell spans more than one slot — the drag
 * snaps the span cell by cell, so a pane can swallow the empty area next to it. Otherwise it
 * falls back to shifting `fr` between the two neighbouring tracks, which is the classic
 * splitter behaviour.
 */
export function useGridCellDrag({ cellId, childIds, layout, onUpdate }: GridCellDragOptions) {
  const stateRef = useRef({ layout, childIds, onUpdate })
  useEffect(() => {
    stateRef.current = { layout, childIds, onUpdate }
  })

  const canDrag = (edge: GridEdge) => {
    if (!layout?.cells[cellId]) return false
    const horizontal = edge === 'left' || edge === 'right'
    const cell = layout.cells[cellId]
    if (freeSpanFor(layout, childIds, cellId, edge) > 0) return true
    if ((horizontal ? cell.colSpan : cell.rowSpan) > 1) return true
    const growIdx =
      edge === 'right'
        ? cell.col + cell.colSpan - 2
        : edge === 'left'
          ? cell.col - 2
          : edge === 'bottom'
            ? cell.row + cell.rowSpan - 2
            : cell.row - 2
    const count = horizontal ? layout.cols : layout.rows
    return growIdx >= 0 && growIdx + 1 < count
  }

  const onPointerDown = (edge: GridEdge) => (event: React.PointerEvent) => {
    const current = stateRef.current.layout
    const cell = current?.cells[cellId]
    if (!current || !cell) return
    event.preventDefault()
    event.stopPropagation()

    const handle = event.currentTarget as HTMLElement
    const gridEl = closestGrid(handle)
    if (!gridEl) return

    const horizontal = edge === 'left' || edge === 'right'
    const spanMode =
      freeSpanFor(current, stateRef.current.childIds, cellId, edge) > 0 ||
      (horizontal ? cell.colSpan : cell.rowSpan) > 1

    handle.setPointerCapture(event.pointerId)

    const onMove = spanMode
      ? (moveEvent: PointerEvent) => {
          const live = stateRef.current.layout
          const liveCell = live?.cells[cellId]
          if (!live || !liveCell) return
          const rect = gridEl.getBoundingClientRect()
          const geometry = trackGeometry(gridEl, horizontal)
          if (!geometry.sizes.length) return
          const position = horizontal ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top
          const track = trackAt(geometry, position)
          const steps =
            edge === 'right'
              ? track - (liveCell.col + liveCell.colSpan - 1)
              : edge === 'bottom'
                ? track - (liveCell.row + liveCell.rowSpan - 1)
                : edge === 'left'
                  ? liveCell.col - track
                  : liveCell.row - track
          if (!steps) return
          const next = expandCell(live, stateRef.current.childIds, cellId, edge, steps)
          if (next !== live) stateRef.current.onUpdate(next)
        }
      : (() => {
          const growIdx =
            edge === 'right'
              ? cell.col + cell.colSpan - 2
              : edge === 'left'
                ? cell.col - 2
                : edge === 'bottom'
                  ? cell.row + cell.rowSpan - 2
                  : cell.row - 2
          const shrinkIdx = growIdx + 1
          const count = horizontal ? current.cols : current.rows
          if (growIdx < 0 || shrinkIdx >= count) return null
          const stored = horizontal ? current.colSizes : current.rowSizes
          const initial = (
            stored && stored.length === count ? stored : Array(count).fill(1)
          ).slice()
          const total = initial.reduce((a, b) => a + b, 0)
          const start = horizontal ? event.clientX : event.clientY
          const combined = initial[growIdx] + initial[shrinkIdx]
          return (moveEvent: PointerEvent) => {
            const live = stateRef.current.layout
            if (!live) return
            const { extent } = trackGeometry(gridEl, horizontal)
            if (!extent) return
            const delta = (horizontal ? moveEvent.clientX : moveEvent.clientY) - start
            const deltaFr = (delta * total) / extent
            const grown = Math.max(MIN_FR, Math.min(combined - MIN_FR, initial[growIdx] + deltaFr))
            const sizes = initial.slice()
            sizes[growIdx] = grown
            sizes[shrinkIdx] = combined - grown
            stateRef.current.onUpdate(
              horizontal ? { ...live, colSizes: sizes } : { ...live, rowSizes: sizes },
            )
          }
        })()

    if (!onMove) {
      handle.releasePointerCapture(event.pointerId)
      return
    }

    const onUp = () => {
      handle.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onDoubleClick = () => {
    const { layout: live, childIds: ids, onUpdate: update } = stateRef.current
    if (!live?.cells[cellId]) return
    const next = fillFreeSpace(live, ids, cellId)
    if (next !== live) update(next)
  }

  return { onPointerDown, onDoubleClick, canDrag }
}
