/**
 * Which edge of a drop target the pointer is currently over, used to preview
 * where a dragged panel/pane will land before it's dropped (see
 * WorkspaceView/ProjectContainer/TerminalPane). `center` is the existing
 * swap-in-place behavior; the four edges mean "insert before/after the
 * target" in layouts that support ordered insertion (see onDragEnd).
 */
export type DropZone = 'top' | 'right' | 'bottom' | 'left' | 'center'

/** Outer quarter on either side of an axis is that axis's edge zone, matching
 * the 25%-wide/tall bar drawn in ProjectContainer/TerminalPane's CSS (if
 * this and the bar's size ever drift apart, the bar shows before the zone
 * is actually reachable, or the reverse). Whichever axis the pointer is
 * furthest toward its edge on wins, so a corner resolves to one bar, not two. */
const EDGE_RATIO = 1 / 4

export function resolveDropZone(
  targetRect: { top: number; left: number; width: number; height: number },
  pointer: { x: number; y: number },
): DropZone {
  if (targetRect.width <= 0 || targetRect.height <= 0) return 'center'

  const relX = (pointer.x - targetRect.left) / targetRect.width
  const relY = (pointer.y - targetRect.top) / targetRect.height

  // Distance (0 at the edge, 0.5 at the center) past the edge threshold, per axis.
  const xEdgeDepth = Math.max(EDGE_RATIO - Math.min(relX, 1 - relX), 0)
  const yEdgeDepth = Math.max(EDGE_RATIO - Math.min(relY, 1 - relY), 0)

  if (xEdgeDepth === 0 && yEdgeDepth === 0) return 'center'

  if (xEdgeDepth >= yEdgeDepth) {
    return relX < 0.5 ? 'left' : 'right'
  }
  return relY < 0.5 ? 'top' : 'bottom'
}

/**
 * Live pointer position during a dnd-kit drag, for `resolveDropZone`.
 *
 * `active.rect.current.translated` is the dragged *node's* rect (its own
 * top-left corner plus its own size), not the cursor. Using its center as a
 * cursor proxy is only right if the pointer happens to be over the node's
 * center, which it usually isn't (people grab a corner drag handle, not the
 * middle of a whole panel). Instead: the pointer's offset from the node's
 * top-left corner is fixed for the whole drag (rigid drag, no independent
 * pointer movement inside the node), so recover it once from
 * `activatorEvent` (the pointer event that started the drag) against the
 * node's `initial` rect, then apply that same offset to `translated`.
 */
export function dragPointer(
  activatorEvent: Event | null,
  activeRect: {
    initial: { top: number; left: number } | null
    translated: { top: number; left: number } | null
  } | null,
): { x: number; y: number } | null {
  if (!activeRect?.initial || !activeRect.translated) return null
  if (!activatorEvent || !('clientX' in activatorEvent) || !('clientY' in activatorEvent)) {
    return null
  }
  const pointerEvent = activatorEvent as PointerEvent
  const offsetX = pointerEvent.clientX - activeRect.initial.left
  const offsetY = pointerEvent.clientY - activeRect.initial.top
  return { x: activeRect.translated.left + offsetX, y: activeRect.translated.top + offsetY }
}

/**
 * Final index to splice the dragged item into an ordered list, given a
 * before/after edge zone. `list.splice(fromIndex, 1)` runs first (standard
 * array-move semantics, see reorderPaneInContainer/reorderContainers), so an
 * item removed from *before* the target shifts every later index back by
 * one, accounted for here so "insert after" lands right after the target
 * regardless of which way the drag crossed it.
 */
export function resolveInsertIndex(
  listLength: number,
  fromIndex: number,
  targetIndex: number,
  edge: 'before' | 'after',
): number {
  let index = edge === 'after' ? targetIndex + 1 : targetIndex
  if (fromIndex < targetIndex) index -= 1
  return Math.max(0, Math.min(index, listLength - 1))
}
