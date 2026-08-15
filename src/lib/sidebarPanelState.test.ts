import { describe, expect, it } from 'vitest'

import { visibilityFromPanelResize, widthFromPanelResize } from './sidebarPanelState'

describe('sidebar panel persistence', () => {
  it('ignores transient collapsed sizes while the startup layout settles', () => {
    expect(visibilityFromPanelResize(false, true, { inPixels: 0 }, { inPixels: 286 }, true)).toBeNull()
    expect(widthFromPanelResize(false, true, { inPixels: 220 }, { inPixels: 286 }, 220, 380)).toBeNull()
  })

  it('ignores automatic layout changes after startup', () => {
    expect(visibilityFromPanelResize(true, false, { inPixels: 0 }, { inPixels: 286 }, true)).toBeNull()
    expect(widthFromPanelResize(true, false, { inPixels: 220 }, { inPixels: 286 }, 220, 380)).toBeNull()
  })

  it('persists explicit collapse and expand changes after startup', () => {
    expect(visibilityFromPanelResize(true, true, { inPixels: 0 }, { inPixels: 286 }, true)).toBe(false)
    expect(visibilityFromPanelResize(true, true, { inPixels: 286 }, { inPixels: 0 }, false)).toBe(true)
  })

  it('persists a user-resized width within panel limits', () => {
    expect(widthFromPanelResize(true, true, { inPixels: 341.6 }, { inPixels: 300 }, 220, 380)).toBe(342)
  })
})
