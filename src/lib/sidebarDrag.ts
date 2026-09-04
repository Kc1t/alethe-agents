export type SidebarDropEdge = 'before' | 'after' | 'inside'
export type SidebarDragKind = 'project' | 'group' | 'terminal'
export type SidebarDropIndicator = { id: string; edge: SidebarDropEdge }

export function sidebarDragKind(id: string | null): SidebarDragKind | null {
  if (id?.startsWith('proj:')) return 'project'
  if (id?.startsWith('grp:')) return 'group'
  if (id?.startsWith('term:')) return 'terminal'
  return null
}

/**
 * Convert a pointer-facing target edge into an insertion index. When source
 * and target share a list, removing the source first shifts later indexes.
 */
export function sidebarInsertionIndex(
  sourceIndex: number,
  targetIndex: number,
  edge: Exclude<SidebarDropEdge, 'inside'>,
  sameList: boolean,
): number {
  let insertionIndex = targetIndex + (edge === 'after' ? 1 : 0)
  if (sameList && sourceIndex < insertionIndex) insertionIndex -= 1
  return Math.max(0, insertionIndex)
}

export const sidebarCollisionDetection: CollisionDetection = (args) => {
  const kind = sidebarDragKind(String(args.active.id))
  const candidates = pointerWithin(args).filter(({ id }) => {
    const target = String(id)
    if (target === String(args.active.id)) return false
    if (kind === 'terminal') return target.startsWith('proj:')
    if (kind === 'project') return target.startsWith('proj:') || target.startsWith('group:')
    if (kind === 'group') {
      const sourceId = String(args.active.id).slice('grp:'.length)
      return (
        target !== `group:${sourceId}` && (target.startsWith('grp:') || target.startsWith('group:'))
      )
    }
    return false
  })

  const rank = (id: string) => {
    if (kind === 'project') return id.startsWith('proj:') ? 0 : 1
    if (kind === 'group') return id.startsWith('grp:') ? 0 : 1
    return 0
  }

  return candidates.sort((a, b) => {
    const rankDifference = rank(String(a.id)) - rank(String(b.id))
    if (rankDifference !== 0) return rankDifference
    const aRect = args.droppableRects.get(a.id)
    const bRect = args.droppableRects.get(b.id)
    const aArea = aRect ? aRect.width * aRect.height : Number.POSITIVE_INFINITY
    const bArea = bRect ? bRect.width * bRect.height : Number.POSITIVE_INFINITY
    return aArea - bArea
  })
}

export function sidebarDropIndicatorForEvent(
  event: DragMoveEvent | DragEndEvent,
): SidebarDropIndicator | null {
  if (!event.over) return null
  const id = String(event.over.id)
  if (id.startsWith('group:') || sidebarDragKind(String(event.active.id)) === 'terminal') {
    return { id, edge: 'inside' }
  }

  const activatorEvent = event.activatorEvent
  const pointerY =
    'clientY' in activatorEvent && typeof activatorEvent.clientY === 'number'
      ? activatorEvent.clientY + event.delta.y
      : event.active.rect.current.translated
        ? event.active.rect.current.translated.top + event.active.rect.current.translated.height / 2
        : event.over.rect.top + event.over.rect.height / 2
  const edge = pointerY < event.over.rect.top + event.over.rect.height / 2 ? 'before' : 'after'
  return { id, edge }
}
import {
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  pointerWithin,
} from '@dnd-kit/core'
