import { autoGridLayout } from './gridLayout'
import type { GridCell, GridLayout } from './types'

export type LayoutPresetId =
  | 'balanced'
  | 'columns'
  | 'rows'
  | 'focus-left'
  | 'focus-top'
  | 'focus-left-grid'
  | 'focus-top-grid'

export type LayoutPresetLabel =
  | 'mod.layoutPresetBalanced'
  | 'mod.layoutPresetColumns'
  | 'mod.layoutPresetRows'
  | 'mod.layoutPresetFocusLeft'
  | 'mod.layoutPresetFocusTop'
  | 'mod.layoutPresetFocusLeftGrid'
  | 'mod.layoutPresetFocusTopGrid'

export type LayoutPreset = {
  id: LayoutPresetId
  label: LayoutPresetLabel
  layout: GridLayout
}

/** How many columns/rows an auto-packed square-ish grid needs for `count`
 * items, capped at 4 per axis like the "balanced" preset above. Shared by
 * `focus-left-grid`/`focus-top-grid` for the non-focused items. */
export function squareGridDims(count: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 }
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))))
  const rows = Math.max(1, Math.ceil(count / cols))
  return { cols, rows }
}

export function createLayoutPresets(childIds: string[]): LayoutPreset[] {
  const count = Math.max(1, childIds.length)
  const balancedCols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(count))))
  const columns = autoGridLayout(childIds, count)
  const rows = autoGridLayout(childIds, 1)
  const focusRows = Math.max(1, childIds.length - 1)
  const focusLeftCells: Record<string, GridCell> = {}
  const focusTopCells: Record<string, GridCell> = {}
  childIds.forEach((id, index) => {
    if (index === 0) {
      focusLeftCells[id] = {
        col: 1,
        row: 1,
        colSpan: childIds.length > 1 ? 1 : 2,
        rowSpan: focusRows,
      }
      focusTopCells[id] = {
        col: 1,
        row: 1,
        colSpan: focusRows,
        rowSpan: childIds.length > 1 ? 1 : 2,
      }
    } else {
      focusLeftCells[id] = { col: 2, row: index, colSpan: 1, rowSpan: 1 }
      focusTopCells[id] = { col: index, row: 2, colSpan: 1, rowSpan: 1 }
    }
  })

  // Same idea as focus-left/focus-top, but the non-focused items pack into
  // an auto square-ish grid instead of a single-wide stack (e.g. one pane
  // as a full column, the other four as a 2x2 block beside it).
  const restCount = Math.max(0, childIds.length - 1)
  const restGrid = squareGridDims(restCount)
  const focusLeftGridCells: Record<string, GridCell> = {}
  const focusTopGridCells: Record<string, GridCell> = {}
  childIds.forEach((id, index) => {
    if (index === 0) {
      focusLeftGridCells[id] = {
        col: 1,
        row: 1,
        colSpan: childIds.length > 1 ? 1 : 1 + restGrid.cols,
        rowSpan: restGrid.rows,
      }
      focusTopGridCells[id] = {
        col: 1,
        row: 1,
        colSpan: restGrid.cols,
        rowSpan: childIds.length > 1 ? 1 : 1 + restGrid.rows,
      }
      return
    }
    const restIndex = index - 1
    const restCol = restIndex % restGrid.cols
    const restRow = Math.floor(restIndex / restGrid.cols)
    focusLeftGridCells[id] = { col: 2 + restCol, row: 1 + restRow, colSpan: 1, rowSpan: 1 }
    focusTopGridCells[id] = { col: 1 + restCol, row: 2 + restRow, colSpan: 1, rowSpan: 1 }
  })

  return [
    {
      id: 'balanced',
      label: 'mod.layoutPresetBalanced',
      layout: autoGridLayout(childIds, balancedCols),
    },
    { id: 'columns', label: 'mod.layoutPresetColumns', layout: columns },
    { id: 'rows', label: 'mod.layoutPresetRows', layout: rows },
    {
      id: 'focus-left',
      label: 'mod.layoutPresetFocusLeft',
      layout: { cols: childIds.length > 1 ? 2 : 1, rows: focusRows, cells: focusLeftCells },
    },
    {
      id: 'focus-top',
      label: 'mod.layoutPresetFocusTop',
      layout: { cols: focusRows, rows: childIds.length > 1 ? 2 : 1, cells: focusTopCells },
    },
    {
      id: 'focus-left-grid',
      label: 'mod.layoutPresetFocusLeftGrid',
      layout: { cols: 1 + restGrid.cols, rows: restGrid.rows, cells: focusLeftGridCells },
    },
    {
      id: 'focus-top-grid',
      label: 'mod.layoutPresetFocusTopGrid',
      layout: { cols: restGrid.cols, rows: 1 + restGrid.rows, cells: focusTopGridCells },
    },
  ]
}
