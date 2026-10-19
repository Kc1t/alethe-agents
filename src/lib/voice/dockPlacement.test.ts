import { describe, expect, it } from 'vitest'

import { DOCK_MARGIN, dockFraction, dockOffset } from './dockPlacement'

const viewport = { width: 1000, height: 800 }
const size = { width: 560, height: 200 }
// Room left for the panel inside the margins: 1000 - 560 - 16 = 424, 800 - 200 - 16 = 584.

describe('dockOffset', () => {
  it('places the panel by its share of the room left in the window', () => {
    expect(dockOffset({ x: 0, y: 0 }, viewport, size)).toEqual({ left: DOCK_MARGIN, top: 8 })
    expect(dockOffset({ x: 1, y: 1 }, viewport, size)).toEqual({ left: 432, top: 592 })
    expect(dockOffset({ x: 0.5, y: 0.25 }, viewport, size)).toEqual({ left: 220, top: 154 })
  })

  // A smaller window, or a panel that grew (a permission card), keeps it inside.
  it('stays inside the window when the window shrinks or the panel grows', () => {
    const corner = { x: 1, y: 1 }
    const small = dockOffset(corner, { width: 700, height: 400 }, { width: 560, height: 300 })
    expect(small).toEqual({ left: 132, top: 92 })
    expect(small.left + 560).toBeLessThanOrEqual(700 - DOCK_MARGIN)
    expect(small.top + 300).toBeLessThanOrEqual(400 - DOCK_MARGIN)
  })

  it('pins to the margin when the panel is larger than the window', () => {
    expect(dockOffset({ x: 1, y: 1 }, { width: 300, height: 100 }, size)).toEqual({
      left: DOCK_MARGIN,
      top: DOCK_MARGIN,
    })
  })
})

describe('dockFraction', () => {
  it('is the inverse of dockOffset', () => {
    const position = { x: 0.3, y: 0.7 }
    const { left, top } = dockOffset(position, viewport, size)
    const back = dockFraction({ left, top }, viewport, size)
    expect(back.x).toBeCloseTo(0.3)
    expect(back.y).toBeCloseTo(0.7)
  })

  it('clamps a spot dragged past the edges', () => {
    expect(dockFraction({ left: -50, top: 5000 }, viewport, size)).toEqual({ x: 0, y: 1 })
  })

  it('centers an axis that has no room to move along', () => {
    expect(dockFraction({ left: 0, top: 0 }, { width: 300, height: 100 }, size)).toEqual({
      x: 0.5,
      y: 0.5,
    })
  })
})
