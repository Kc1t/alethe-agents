import { describe, expect, it } from 'vitest'

import {
  autoGridLayout,
  cellStyle,
  expandCell,
  fillFreeSpace,
  freeCells,
  freeSpanFor,
  hasFreeCells,
  moveCellTo,
  occupancyGrid,
  reconcileGridLayout,
} from './gridLayout'
import type { GridLayout } from './types'

/** 2x2 grid with three children: the bottom-right slot is free. */
function threeInFour(): GridLayout {
  return {
    cols: 2,
    rows: 2,
    cells: {
      a: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      b: { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      c: { col: 1, row: 2, colSpan: 1, rowSpan: 1 },
    },
  }
}

describe('autoGridLayout', () => {
  it('distribui filhos em 2 colunas por padrão (linha a linha)', () => {
    const layout = autoGridLayout(['a', 'b', 'c'])
    expect(layout.cols).toBe(2)
    expect(layout.rows).toBe(2) // ceil(3/2)
    expect(layout.cells.a).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.b).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 1 })
    expect(layout.cells.c).toEqual({ col: 1, row: 2, colSpan: 1, rowSpan: 1 })
  })

  it('mantém no mínimo 1 linha mesmo sem filhos', () => {
    const layout = autoGridLayout([])
    expect(layout.rows).toBe(1)
    expect(layout.cells).toEqual({})
  })

  it('respeita o número de colunas pedido', () => {
    const layout = autoGridLayout(['a', 'b', 'c', 'd'], 3)
    expect(layout.cols).toBe(3)
    expect(layout.rows).toBe(2) // ceil(4/3)
    expect(layout.cells.d).toEqual({ col: 1, row: 2, colSpan: 1, rowSpan: 1 })
  })
})

describe('reconcileGridLayout', () => {
  it('preenche filhos sem célula com auto-fill sem colidir', () => {
    const layout: GridLayout = { cols: 2, rows: 1, cells: {} }
    const out = reconcileGridLayout(layout, ['a', 'b'])
    // ocupam slots distintos
    const keys = new Set(Object.values(out.cells).map((c) => `${c.row}:${c.col}`))
    expect(keys.size).toBe(2)
  })

  it('resolve colisão movendo o segundo item para o próximo slot livre', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 1,
      cells: {
        a: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
        b: { col: 1, row: 1, colSpan: 1, rowSpan: 1 }, // colide com a
      },
    }
    const out = reconcileGridLayout(layout, ['a', 'b'])
    expect(out.cells.a).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 1 })
    expect(`${out.cells.b.row}:${out.cells.b.col}`).not.toBe('1:1')
  })

  it('expande linhas quando não há espaço no grid declarado', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 1,
      cells: {
        a: { col: 1, row: 1, colSpan: 2, rowSpan: 1 },
        b: { col: 1, row: 1, colSpan: 2, rowSpan: 1 },
      },
    }
    const out = reconcileGridLayout(layout, ['a', 'b'])
    expect(out.rows).toBeGreaterThanOrEqual(2)
    expect(out.cells.b.row).toBe(2)
  })

  it('clampa célula fora dos limites para dentro do grid', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 2,
      cells: {
        a: { col: 99, row: 99, colSpan: 99, rowSpan: 99 },
      },
    }
    const out = reconcileGridLayout(layout, ['a'])
    const c = out.cells.a
    expect(c.col).toBeGreaterThanOrEqual(1)
    expect(c.row).toBeGreaterThanOrEqual(1)
    expect(c.col + c.colSpan - 1).toBeLessThanOrEqual(out.cols)
  })

  it('ignora cols/rows inválidos caindo para no mínimo 1', () => {
    const layout = { cols: 0, rows: 0, cells: {} } as unknown as GridLayout
    const out = reconcileGridLayout(layout, ['a'])
    expect(out.cols).toBeGreaterThanOrEqual(1)
    expect(out.rows).toBeGreaterThanOrEqual(1)
    expect(out.cells.a).toBeDefined()
  })

  it('mantém colSizes só quando o comprimento bate com cols', () => {
    const ok: GridLayout = { cols: 2, rows: 1, cells: {}, colSizes: [1, 2] }
    expect(reconcileGridLayout(ok, []).colSizes).toEqual([1, 2])

    const mismatched: GridLayout = { cols: 2, rows: 1, cells: {}, colSizes: [1] }
    expect(reconcileGridLayout(mismatched, []).colSizes).toBeUndefined()
  })
})

describe('occupancyGrid / freeCells', () => {
  const ids = ['a', 'b', 'c']

  it('maps every slot to its occupant and leaves holes as null', () => {
    const grid = occupancyGrid(threeInFour(), ids)
    expect(grid).toEqual([
      ['a', 'b'],
      ['c', null],
    ])
  })

  it('lists the free slots and reports that the layout has holes', () => {
    expect(freeCells(threeInFour(), ids)).toEqual([{ col: 2, row: 2 }])
    expect(hasFreeCells(threeInFour(), ids)).toBe(true)
    expect(hasFreeCells(autoGridLayout(['a', 'b']), ['a', 'b'])).toBe(false)
  })
})

describe('freeSpanFor', () => {
  const ids = ['a', 'b', 'c']

  it('counts free slots past an edge', () => {
    expect(freeSpanFor(threeInFour(), ids, 'c', 'right')).toBe(1)
    expect(freeSpanFor(threeInFour(), ids, 'b', 'bottom')).toBe(1)
  })

  it('returns 0 when the neighbouring line is occupied or out of bounds', () => {
    expect(freeSpanFor(threeInFour(), ids, 'c', 'top')).toBe(0)
    expect(freeSpanFor(threeInFour(), ids, 'a', 'left')).toBe(0)
    expect(freeSpanFor(threeInFour(), ids, 'a', 'right')).toBe(0)
  })

  it('requires the whole line to be free', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 3,
      cells: {
        a: { col: 1, row: 1, colSpan: 2, rowSpan: 1 },
        b: { col: 1, row: 2, colSpan: 1, rowSpan: 1 },
      },
    }
    // Row 2 still holds `b`, so `a` cannot grow down even though (2,2) is free.
    expect(freeSpanFor(layout, ['a', 'b'], 'a', 'bottom')).toBe(0)
  })
})

describe('expandCell', () => {
  const ids = ['a', 'b', 'c']

  it('grows into the free slot and caps at the available span', () => {
    const out = expandCell(threeInFour(), ids, 'c', 'right', 5)
    expect(out.cells.c).toEqual({ col: 1, row: 2, colSpan: 2, rowSpan: 1 })
  })

  it('grows towards the left by moving the origin', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 1,
      cells: { a: { col: 2, row: 1, colSpan: 1, rowSpan: 1 } },
    }
    expect(expandCell(layout, ['a'], 'a', 'left', 1).cells.a).toEqual({
      col: 1,
      row: 1,
      colSpan: 2,
      rowSpan: 1,
    })
  })

  it('shrinks without going below a single slot', () => {
    const grown = expandCell(threeInFour(), ids, 'c', 'right', 1)
    expect(expandCell(grown, ids, 'c', 'right', -1).cells.c.colSpan).toBe(1)
    expect(expandCell(grown, ids, 'c', 'right', -9).cells.c.colSpan).toBe(1)
  })

  it('is a no-op when there is nothing to grow into', () => {
    const layout = threeInFour()
    expect(expandCell(layout, ids, 'a', 'right', 1)).toBe(layout)
  })
})

describe('fillFreeSpace', () => {
  it('lets the bottom pane take the whole row', () => {
    const out = fillFreeSpace(threeInFour(), ['a', 'b', 'c'], 'c')
    expect(out.cells.c).toEqual({ col: 1, row: 2, colSpan: 2, rowSpan: 1 })
    expect(hasFreeCells(out, ['a', 'b', 'c'])).toBe(false)
  })

  it('stops at the neighbour instead of overlapping it', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 2,
      cells: {
        a: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
        b: { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      },
    }
    const out = fillFreeSpace(layout, ['a', 'b'], 'b')
    expect(out.cells.b).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 2 })
    expect(out.cells.a).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 1 })
  })

  it('takes the whole grid when it is the only child', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 2,
      cells: { a: { col: 2, row: 2, colSpan: 1, rowSpan: 1 } },
    }
    expect(fillFreeSpace(layout, ['a'], 'a').cells.a).toEqual({
      col: 1,
      row: 1,
      colSpan: 2,
      rowSpan: 2,
    })
  })
})

describe('moveCellTo', () => {
  const ids = ['a', 'b', 'c']

  it('moves into a free slot without touching the others', () => {
    const out = moveCellTo(threeInFour(), ids, 'c', 2, 2)
    expect(out.cells.c).toEqual({ col: 2, row: 2, colSpan: 1, rowSpan: 1 })
    expect(out.cells.a).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 1 })
    expect(out.cells.b).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 1 })
  })

  it('swaps with the occupant of the target slot', () => {
    const out = moveCellTo(threeInFour(), ids, 'c', 2, 1)
    expect(out.cells.c).toEqual({ col: 2, row: 1, colSpan: 1, rowSpan: 1 })
    expect(out.cells.b).toEqual({ col: 1, row: 2, colSpan: 1, rowSpan: 1 })
  })

  it('drops to a single slot when the span would cover several children', () => {
    const layout: GridLayout = {
      cols: 2,
      rows: 2,
      cells: {
        a: { col: 1, row: 1, colSpan: 2, rowSpan: 1 },
        b: { col: 1, row: 2, colSpan: 1, rowSpan: 1 },
        c: { col: 2, row: 2, colSpan: 1, rowSpan: 1 },
      },
    }
    const out = moveCellTo(layout, ids, 'a', 1, 2)
    expect(out.cells.a).toEqual({ col: 1, row: 2, colSpan: 1, rowSpan: 1 })
    expect(out.cells.b).toEqual({ col: 1, row: 1, colSpan: 1, rowSpan: 1 })
  })

  it('keeps the layout untouched when the target equals the source', () => {
    const layout = threeInFour()
    expect(moveCellTo(layout, ids, 'a', 1, 1)).toBe(layout)
  })
})

describe('cellStyle', () => {
  it('gera as regras de grid-column/row com span', () => {
    expect(cellStyle({ col: 2, row: 3, colSpan: 2, rowSpan: 1 })).toEqual({
      gridColumn: '2 / span 2',
      gridRow: '3 / span 1',
      minWidth: 0,
      minHeight: 0,
    })
  })
})
