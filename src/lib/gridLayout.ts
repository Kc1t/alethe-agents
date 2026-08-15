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

/** CSS style pro container do grid. */
export function gridContainerStyle(layout: GridLayout): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: trackTemplate(layout.cols, layout.colSizes),
    gridTemplateRows: trackTemplate(layout.rows, layout.rowSizes),
    gap: 0,
    width: '100%',
    height: '100%',
  }
}
