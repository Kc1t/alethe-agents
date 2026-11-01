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

/**
 * The group a dragged project lands in: a group's header or body, or `null` for the ungrouped
 * list. `undefined` when the target is not a group at all.
 */
export function projectDropGroupId(target: string): string | null | undefined {
  const groupId = target.startsWith('group:')
    ? target.slice('group:'.length)
    : target.startsWith('group-body:')
      ? target.slice('group-body:'.length)
      : undefined
  if (groupId === undefined) return undefined
  return groupId === 'ungrouped' ? null : groupId
}
