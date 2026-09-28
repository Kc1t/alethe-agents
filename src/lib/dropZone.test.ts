import { describe, expect, it } from 'vitest'

import { dragPointer, resolveDropZone, resolveInsertIndex } from './dropZone'

const rect = { top: 0, left: 0, width: 120, height: 60 }

describe('resolveDropZone', () => {
  it('returns center for the middle of the target', () => {
    expect(resolveDropZone(rect, { x: 60, y: 30 })).toBe('center')
  })

  it('returns left/right near the horizontal edges', () => {
    expect(resolveDropZone(rect, { x: 2, y: 30 })).toBe('left')
    expect(resolveDropZone(rect, { x: 118, y: 30 })).toBe('right')
  })

  it('returns top/bottom near the vertical edges', () => {
    expect(resolveDropZone(rect, { x: 60, y: 2 })).toBe('top')
    expect(resolveDropZone(rect, { x: 60, y: 58 })).toBe('bottom')
  })

  it('picks whichever axis is deeper into its edge for a corner', () => {
    // Closer to the left edge (x) than the top edge (y) in relative terms.
    expect(resolveDropZone(rect, { x: 1, y: 8 })).toBe('left')
  })

  it('falls back to center for a zero-size rect', () => {
    expect(resolveDropZone({ top: 0, left: 0, width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center')
  })
})

describe('dragPointer', () => {
  const initial = { top: 100, left: 200 }

  it('recovers the actual pointer position, not the dragged node center', () => {
    // Grabbed 10px from the node's left edge, 5px from its top (a corner
    // drag handle, not the node's center); clientX/clientY reflect that.
    const activatorEvent = { clientX: 210, clientY: 105 } as PointerEvent
    // Dragged the node (and, rigidly, the pointer) 50px right, 30px down.
    const translated = { top: 130, left: 250 }
    expect(dragPointer(activatorEvent, { initial, translated })).toEqual({ x: 260, y: 135 })
  })

  it('returns null without a pointer-like activator event', () => {
    const translated = { top: 130, left: 250 }
    expect(dragPointer(new Event('keydown'), { initial, translated })).toBeNull()
    expect(dragPointer(null, { initial, translated })).toBeNull()
  })

  it('returns null with no initial/translated rect yet', () => {
    const activatorEvent = { clientX: 210, clientY: 105 } as PointerEvent
    expect(dragPointer(activatorEvent, { initial: null, translated: null })).toBeNull()
    expect(dragPointer(activatorEvent, null)).toBeNull()
  })
})

describe('resolveInsertIndex', () => {
  // List [A, B, C, D] (indices 0-3) for every case below, simulating the same
  // splice(from, 1) + splice(to, 0, moved) that reorderPaneInContainer and
  // reorderContainers actually run.
  const simulate = (from: number, to: number) => {
    const list = ['A', 'B', 'C', 'D']
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    return list.join('')
  }

  it('drops after the target when dragging an earlier item forward', () => {
    const index = resolveInsertIndex(4, 0, 2, 'after') // drag A after C
    expect(simulate(0, index)).toBe('BCAD')
  })

  it('drops before the target when dragging an earlier item forward', () => {
    const index = resolveInsertIndex(4, 0, 2, 'before') // drag A before C
    expect(simulate(0, index)).toBe('BACD')
  })

  it('drops before the target when dragging a later item backward', () => {
    const index = resolveInsertIndex(4, 3, 1, 'before') // drag D before B
    expect(simulate(3, index)).toBe('ADBC')
  })

  it('drops after the target when dragging a later item backward', () => {
    const index = resolveInsertIndex(4, 3, 1, 'after') // drag D after B
    expect(simulate(3, index)).toBe('ABDC')
  })

  it('clamps to a valid index', () => {
    expect(resolveInsertIndex(4, 0, 3, 'after')).toBe(3)
    expect(resolveInsertIndex(1, 0, 0, 'after')).toBe(0)
  })
})
