import { describe, expect, it } from 'vitest'

import { createLayoutPresets, squareGridDims } from './layoutPresets'

describe('squareGridDims', () => {
  it('packs a perfect square exactly', () => {
    expect(squareGridDims(4)).toEqual({ cols: 2, rows: 2 })
    expect(squareGridDims(9)).toEqual({ cols: 3, rows: 3 })
  })

  it('rounds up to the next square-ish shape for a non-square count', () => {
    expect(squareGridDims(5)).toEqual({ cols: 3, rows: 2 })
    expect(squareGridDims(2)).toEqual({ cols: 2, rows: 1 })
  })

  it('caps columns at 4 for a large count', () => {
    expect(squareGridDims(20)).toEqual({ cols: 4, rows: 5 })
  })

  it('falls back to a single cell for zero or negative counts', () => {
    expect(squareGridDims(0)).toEqual({ cols: 1, rows: 1 })
    expect(squareGridDims(-1)).toEqual({ cols: 1, rows: 1 })
  })
})

describe('createLayoutPresets: focus-left-grid / focus-top-grid', () => {
  it('puts the first pane in its own full-height column and packs the rest into a grid beside it', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'] // 1 focused + 4 rest -> 2x2
    const presets = createLayoutPresets(ids)
    const leftGrid = presets.find((p) => p.id === 'focus-left-grid')
    expect(leftGrid).toBeDefined()
    const { layout } = leftGrid!

    // Overall grid: 1 focus column + a 2x2 block = 3 cols, 2 rows.
    expect(layout.cols).toBe(3)
    expect(layout.rows).toBe(2)

    // The focused pane spans the full height, in column 1.
    expect(layout.cells.a).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 2 })

    // The other four pack left-to-right, top-to-bottom into the 2x2 block
    // starting at column 2.
    expect(layout.cells.b).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.c).toEqual({ col: 3, row: 1, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.d).toEqual({ col: 2, row: 2, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.e).toEqual({ col: 3, row: 2, colSpan: 1, rowSpan: 1 })
  })

  it('mirrors rows/columns for focus-top-grid', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const presets = createLayoutPresets(ids)
    const topGrid = presets.find((p) => p.id === 'focus-top-grid')
    const { layout } = topGrid!

    expect(layout.cols).toBe(2)
    expect(layout.rows).toBe(3)
    expect(layout.cells.a).toEqual({ col: 1, row: 1, colSpan: 2, rowSpan: 1 })
    expect(layout.cells.b).toEqual({ col: 1, row: 2, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.e).toEqual({ col: 2, row: 3, colSpan: 1, rowSpan: 1 })
  })

  it('degrades to a single 2x1 cell (focused pane spanning both) with only one pane total', () => {
    const presets = createLayoutPresets(['solo'])
    const leftGrid = presets.find((p) => p.id === 'focus-left-grid')!
    expect(leftGrid.layout.cols).toBe(2)
    expect(leftGrid.layout.rows).toBe(1)
    expect(leftGrid.layout.cells.solo).toEqual({ col: 1, row: 1, colSpan: 2, rowSpan: 1 })
  })

  it('stays inside its own declared grid bounds at every pane count', () => {
    // Scoped to the two presets added here; pre-existing presets
    // (balanced/columns/rows/focus-left/focus-top) are out of scope.
    const newPresetIds = new Set(['focus-left-grid', 'focus-top-grid'])
    for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
      const ids = Array.from({ length: count }, (_, i) => `pane-${i}`)
      for (const preset of createLayoutPresets(ids).filter((p) => newPresetIds.has(p.id))) {
        for (const id of ids) {
          const cell = preset.layout.cells[id]
          expect(cell, `${preset.id} is missing a cell for ${id}`).toBeDefined()
          expect(cell.col + cell.colSpan - 1).toBeLessThanOrEqual(preset.layout.cols)
          expect(cell.row + cell.rowSpan - 1).toBeLessThanOrEqual(preset.layout.rows)
        }
      }
    }
  })
})
