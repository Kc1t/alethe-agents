import { describe, expect, it } from 'vitest'

import { autoGridLayout, cellStyle, reconcileGridLayout } from './gridLayout'
import type { GridLayout } from './types'

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
