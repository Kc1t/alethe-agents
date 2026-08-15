import type React from 'react'
import type { GridLayout } from '../lib/types'

   
                                                                      
                                                                            
                                      
   
export function useGridResize(
  cellId: string,
  gridLayout: GridLayout | null,
  onUpdate: (layout: GridLayout) => void,
) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!gridLayout) return
    const cell = gridLayout.cells[cellId]
    if (!cell) return

    const node = (e.currentTarget as HTMLElement).closest(
      '[data-pane-box="1"]',
    ) as HTMLElement | null
    if (!node) return
    let gridEl: HTMLElement | null = node.parentElement
    while (gridEl && getComputedStyle(gridEl).display !== 'grid') {
      gridEl = gridEl.parentElement
    }
    if (!gridEl) return

    const rect = gridEl.getBoundingClientRect()
    const initialCols = (
      gridLayout.colSizes && gridLayout.colSizes.length === gridLayout.cols
        ? gridLayout.colSizes
        : Array(gridLayout.cols).fill(1)
    ).slice()
    const initialRows = (
      gridLayout.rowSizes && gridLayout.rowSizes.length === gridLayout.rows
        ? gridLayout.rowSizes
        : Array(gridLayout.rows).fill(1)
    ).slice()
    const totalColUnits = initialCols.reduce((a, b) => a + b, 0)
    const totalRowUnits = initialRows.reduce((a, b) => a + b, 0)

    const lastColIdx = cell.col + cell.colSpan - 2
    const nextColIdx = lastColIdx + 1
    const lastRowIdx = cell.row + cell.rowSpan - 2
    const nextRowIdx = lastRowIdx + 1

    const canResizeX = nextColIdx >= 0 && nextColIdx < gridLayout.cols
    const canResizeY = nextRowIdx >= 0 && nextRowIdx < gridLayout.rows

    const startX = e.clientX
    const startY = e.clientY
    const minFr = 0.1

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const colSizes = initialCols.slice()
      const rowSizes = initialRows.slice()

      if (canResizeX) {
        const deltaFr = (dx * totalColUnits) / rect.width
        const combined = initialCols[lastColIdx] + initialCols[nextColIdx]
        const grown = Math.max(minFr, Math.min(combined - minFr, initialCols[lastColIdx] + deltaFr))
        colSizes[lastColIdx] = grown
        colSizes[nextColIdx] = combined - grown
      }
      if (canResizeY) {
        const deltaFr = (dy * totalRowUnits) / rect.height
        const combined = initialRows[lastRowIdx] + initialRows[nextRowIdx]
        const grown = Math.max(minFr, Math.min(combined - minFr, initialRows[lastRowIdx] + deltaFr))
        rowSizes[lastRowIdx] = grown
        rowSizes[nextRowIdx] = combined - grown
      }
      if (!canResizeX && !canResizeY) return

      onUpdate({ ...gridLayout, colSizes, rowSizes })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return onPointerDown
}
