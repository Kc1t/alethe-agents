import { autoGridLayout } from './gridLayout'
import type { GridCell, GridLayout } from './types'

export type LayoutPresetId = 'balanced' | 'columns' | 'rows' | 'focus-left' | 'focus-top'

export type LayoutPresetLabel =
  | 'mod.layoutPresetBalanced'
  | 'mod.layoutPresetColumns'
  | 'mod.layoutPresetRows'
  | 'mod.layoutPresetFocusLeft'
  | 'mod.layoutPresetFocusTop'

export type LayoutPreset = {
  id: LayoutPresetId
  label: LayoutPresetLabel
  layout: GridLayout
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
  ]
}
