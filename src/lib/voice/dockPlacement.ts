import type { VoiceDockPosition } from '../types'

/** Gap kept between the in-window voice panel and the window's edges. */
export const DOCK_MARGIN = 8

type Size = { width: number; height: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
/** The room the panel can move along one axis without leaving the margins. */
const room = (outer: number, inner: number) => Math.max(0, outer - inner - 2 * DOCK_MARGIN)

/**
 * Where the panel's top-left sits, in CSS pixels, for a position saved as shares of the room left
 * in the window. Computed from the current window and panel size, so it never leaves the window.
 */
export function dockOffset(
  position: VoiceDockPosition,
  viewport: Size,
  size: Size,
): { left: number; top: number } {
  return {
    left: Math.round(DOCK_MARGIN + clamp01(position.x) * room(viewport.width, size.width)),
    top: Math.round(DOCK_MARGIN + clamp01(position.y) * room(viewport.height, size.height)),
  }
}

/** The position to save for a panel dragged to `offset`; an axis with no room is centered. */
export function dockFraction(
  offset: { left: number; top: number },
  viewport: Size,
  size: Size,
): VoiceDockPosition {
  const share = (at: number, outer: number, inner: number) => {
    const free = room(outer, inner)
    return free > 0 ? clamp01((at - DOCK_MARGIN) / free) : 0.5
  }
  return {
    x: share(offset.left, viewport.width, size.width),
    y: share(offset.top, viewport.height, size.height),
  }
}
