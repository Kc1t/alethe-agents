import type { CSSProperties } from 'react'

import type { GridCell, GridLayout } from './types'

export function autoGridLayout(childIds: string[], cols = 2): GridLayout {
  const rows = Math.max(1, Math.ceil(childIds.length / cols))
  const cells: Record<string, GridCell> = {}
  childIds.forEach((id, i) => {
    cells[id] = {
      col: (i % cols) + 1,
      row: Math.floor(i / cols) + 1,
      colSpan: 1,
      rowSpan: 1,
    }
  })
  return { cols, rows, cells }
}

export function reconcileGridLayout(layout: GridLayout, childIds: string[]): GridLayout {
  const cols = Math.max(1, Math.floor(layout.cols) || 1)
  let rows = Math.max(1, Math.floor(layout.rows) || 1)
  const cells: Record<string, GridCell> = {}
  const occupied = new Set<string>()

  const overlaps = (cell: GridCell) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        if (occupied.has(`${r}:${c}`)) return true
      }
    }
    return false
  }

  const occupy = (cell: GridCell) => {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        occupied.add(`${r}:${c}`)
      }
    }
  }

  const normalize = (cell: GridCell | undefined): GridCell => {
    const colSpan = Math.max(1, Math.min(cols, Math.floor(cell?.colSpan ?? 1) || 1))
    const rowSpan = Math.max(1, Math.min(rows, Math.floor(cell?.rowSpan ?? 1) || 1))
    return {
      col: Math.max(1, Math.min(cols - colSpan + 1, Math.floor(cell?.col ?? 1) || 1)),
      row: Math.max(1, Math.min(rows - rowSpan + 1, Math.floor(cell?.row ?? 1) || 1)),
      colSpan,
      rowSpan,
    }
  }

  const findFreeSpot = (colSpan: number, rowSpan: number): GridCell => {
    for (;;) {
      for (let row = 1; row <= rows - rowSpan + 1; row++) {
        for (let col = 1; col <= cols - colSpan + 1; col++) {
          const candidate = { col, row, colSpan, rowSpan }
          if (!overlaps(candidate)) return candidate
        }
      }
      rows += 1
    }
  }

  for (const id of childIds) {
    const preferred = normalize(layout.cells[id])
    const cell = overlaps(preferred)
      ? findFreeSpot(preferred.colSpan, preferred.rowSpan)
      : preferred
    cells[id] = cell
    occupy(cell)
  }

  const colSizes =
    layout.colSizes && layout.colSizes.length === cols
      ? layout.colSizes.map((size) => Math.max(0.1, Number(size) || 1))
      : undefined
  const rowSizes = (() => {
    if (!layout.rowSizes) return undefined
    const next = layout.rowSizes.slice(0, rows).map((size) => Math.max(0.1, Number(size) || 1))
    while (next.length < rows) {
      next.push(1)
    }
    return next
  })()

  return {
    cols,
    rows,
    cells,
    colSizes,
    rowSizes,
  }
}

export type GridEdge = 'left' | 'right' | 'top' | 'bottom'

function clampCellToLayout(layout: GridLayout, cell: GridCell): GridCell {
  const cols = Math.max(1, Math.floor(layout.cols) || 1)
  const rows = Math.max(1, Math.floor(layout.rows) || 1)
  const colSpan = Math.max(1, Math.min(cols, Math.floor(cell.colSpan) || 1))
  const rowSpan = Math.max(1, Math.min(rows, Math.floor(cell.rowSpan) || 1))
  return {
    col: Math.max(1, Math.min(cols - colSpan + 1, Math.floor(cell.col) || 1)),
    row: Math.max(1, Math.min(rows - rowSpan + 1, Math.floor(cell.row) || 1)),
    colSpan,
    rowSpan,
  }
}

/** Matrix [row - 1][col - 1] holding the id occupying that slot, or null when free. */
export function occupancyGrid(layout: GridLayout, childIds: string[]): (string | null)[][] {
  const cols = Math.max(1, Math.floor(layout.cols) || 1)
  const rows = Math.max(1, Math.floor(layout.rows) || 1)
  const grid: (string | null)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  )
  for (const id of childIds) {
    const raw = layout.cells[id]
    if (!raw) continue
    const cell = clampCellToLayout(layout, raw)
    for (let r = cell.row; r < cell.row + cell.rowSpan && r <= rows; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan && c <= cols; c++) {
        grid[r - 1][c - 1] = id
      }
    }
  }
  return grid
}

/** Free slots of the layout, in row-major order. */
export function freeCells(layout: GridLayout, childIds: string[]): { col: number; row: number }[] {
  const grid = occupancyGrid(layout, childIds)
  const out: { col: number; row: number }[] = []
  grid.forEach((line, rowIdx) => {
    line.forEach((occupant, colIdx) => {
      if (!occupant) out.push({ col: colIdx + 1, row: rowIdx + 1 })
    })
  })
  return out
}

export function hasFreeCells(layout: GridLayout, childIds: string[]): boolean {
  return occupancyGrid(layout, childIds).some((line) => line.some((occupant) => !occupant))
}

/**
 * How many whole lines of free slots exist past `edge`. A line only counts when every slot
 * along the cell's opposite axis is free, so growing never overlaps a neighbour.
 */
export function freeSpanFor(
  layout: GridLayout,
  childIds: string[],
  id: string,
  edge: GridEdge,
): number {
  const raw = layout.cells[id]
  if (!raw) return 0
  const cols = Math.max(1, Math.floor(layout.cols) || 1)
  const rows = Math.max(1, Math.floor(layout.rows) || 1)
  const cell = clampCellToLayout(layout, raw)
  const grid = occupancyGrid(layout, childIds)

  const lineIsFree = (col: number, row: number, horizontal: boolean) => {
    if (horizontal) {
      if (col < 1 || col > cols) return false
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
        if (r > rows || grid[r - 1][col - 1]) return false
      }
      return true
    }
    if (row < 1 || row > rows) return false
    for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
      if (c > cols || grid[row - 1][c - 1]) return false
    }
    return true
  }

  let span = 0
  for (let step = 1; ; step++) {
    const free =
      edge === 'right'
        ? lineIsFree(cell.col + cell.colSpan - 1 + step, 0, true)
        : edge === 'left'
          ? lineIsFree(cell.col - step, 0, true)
          : edge === 'bottom'
            ? lineIsFree(0, cell.row + cell.rowSpan - 1 + step, false)
            : lineIsFree(0, cell.row - step, false)
    if (!free) break
    span = step
  }
  return span
}

/**
 * Grows (`steps > 0`) or shrinks (`steps < 0`) a cell towards one edge. Growth is capped by
 * the free space in that direction; shrinking never goes below a single slot.
 */
export function expandCell(
  layout: GridLayout,
  childIds: string[],
  id: string,
  edge: GridEdge,
  steps: number,
): GridLayout {
  const raw = layout.cells[id]
  if (!raw || !steps) return layout
  const cell = clampCellToLayout(layout, raw)
  const horizontal = edge === 'left' || edge === 'right'
  const span = horizontal ? cell.colSpan : cell.rowSpan
  const amount =
    steps > 0
      ? Math.min(steps, freeSpanFor(layout, childIds, id, edge))
      : -Math.min(-steps, span - 1)
  if (!amount) return layout

  const next = { ...cell }
  if (edge === 'right') next.colSpan += amount
  else if (edge === 'bottom') next.rowSpan += amount
  else if (edge === 'left') {
    next.col -= amount
    next.colSpan += amount
  } else {
    next.row -= amount
    next.rowSpan += amount
  }
  return { ...layout, cells: { ...layout.cells, [id]: next } }
}

/** Grows a cell over every free slot reachable from it, greedily. */
export function fillFreeSpace(layout: GridLayout, childIds: string[], id: string): GridLayout {
  if (!layout.cells[id]) return layout
  const edges: GridEdge[] = ['right', 'bottom', 'left', 'top']
  let current = layout
  const maxPasses = Math.max(1, layout.cols * layout.rows)
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false
    for (const edge of edges) {
      const span = freeSpanFor(current, childIds, id, edge)
      if (span <= 0) continue
      current = expandCell(current, childIds, id, edge, span)
      changed = true
    }
    if (!changed) break
  }
  return current
}

/**
 * Moves a cell so its top-left sits at (col, row). Landing on free space just moves it;
 * landing on another child swaps the two.
 */
export function moveCellTo(
  layout: GridLayout,
  childIds: string[],
  id: string,
  col: number,
  row: number,
): GridLayout {
  const raw = layout.cells[id]
  if (!raw) return layout
  const cols = Math.max(1, Math.floor(layout.cols) || 1)
  const rows = Math.max(1, Math.floor(layout.rows) || 1)
  const source = clampCellToLayout(layout, raw)
  const targetCol = Math.max(1, Math.min(cols, Math.floor(col) || 1))
  const targetRow = Math.max(1, Math.min(rows, Math.floor(row) || 1))
  if (targetCol === source.col && targetRow === source.row) return layout

  const overlapping = (cell: GridCell) =>
    childIds.filter((childId) => {
      if (childId === id) return false
      const other = layout.cells[childId]
      if (!other) return false
      const o = clampCellToLayout(layout, other)
      return (
        cell.col < o.col + o.colSpan &&
        cell.col + cell.colSpan > o.col &&
        cell.row < o.row + o.rowSpan &&
        cell.row + cell.rowSpan > o.row
      )
    })

  let target: GridCell = {
    col: targetCol,
    row: targetRow,
    colSpan: Math.max(1, Math.min(source.colSpan, cols - targetCol + 1)),
    rowSpan: Math.max(1, Math.min(source.rowSpan, rows - targetRow + 1)),
  }
  let occupants = overlapping(target)
  if (occupants.length > 1) {
    target = { ...target, colSpan: 1, rowSpan: 1 }
    occupants = overlapping(target)
  }

  const cells = { ...layout.cells, [id]: target }
  if (occupants.length === 1) {
    const otherId = occupants[0]
    const other = clampCellToLayout(layout, layout.cells[otherId])
    cells[otherId] = clampCellToLayout(layout, {
      col: source.col,
      row: source.row,
      colSpan: Math.min(other.colSpan, cols - source.col + 1),
      rowSpan: Math.min(other.rowSpan, rows - source.row + 1),
    })
  }
  return { ...layout, cells }
}

function trackTemplate(count: number, sizes: number[] | undefined): string {
  if (!sizes || sizes.length !== count) {
    return `repeat(${count}, minmax(0, 1fr))`
  }
  return sizes.map((s) => `minmax(0, ${Math.max(0.1, s)}fr)`).join(' ')
}

export function cellStyle(cell: GridCell): CSSProperties {
  return {
    gridColumn: `${cell.col} / span ${cell.colSpan}`,
    gridRow: `${cell.row} / span ${cell.rowSpan}`,
    minWidth: 0,
    minHeight: 0,
  }
}

/** Track templates only, for containers that bring their own gap/padding. */
export function gridTrackStyle(layout: GridLayout): CSSProperties {
  return {
    gridTemplateColumns: trackTemplate(layout.cols, layout.colSizes),
    gridTemplateRows: trackTemplate(layout.rows, layout.rowSizes),
  }
}

/** CSS style pro container do grid. */
export function gridContainerStyle(layout: GridLayout): CSSProperties {
  return {
    display: 'grid',
    ...gridTrackStyle(layout),
    gap: 0,
    width: '100%',
    height: '100%',
  }
}
