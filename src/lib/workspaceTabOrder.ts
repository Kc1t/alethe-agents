type OrderedTab = { id: string; pinned?: boolean }
type Slot = { left: number; width: number }

/** Moves a tab to `toIndex`, clamped so pinned tabs stay before unpinned ones. */
export function moveWorkspaceTab<T extends OrderedTab>(
  tabs: readonly T[],
  tabId: string,
  toIndex: number,
): T[] {
  const from = tabs.findIndex((tab) => tab.id === tabId)
  if (from === -1) return tabs as T[]
  const pinnedCount = tabs.filter((tab) => tab.pinned).length
  const [min, max] = tabs[from].pinned ? [0, pinnedCount - 1] : [pinnedCount, tabs.length - 1]
  const to = Math.min(Math.max(toIndex, min), max)
  if (to === from) return tabs as T[]
  const next = tabs.filter((_, index) => index !== from)
  next.splice(to, 0, tabs[from])
  return next
}

/** An already open tab keeps its place; a new one goes last. */
export function placeOpenedTab<T extends OrderedTab>(tabs: readonly T[], tab: T): T[] {
  const index = tabs.findIndex((item) => item.id === tab.id)
  if (index === -1) return [...tabs, tab]
  return tabs.map((item, position) => (position === index ? tab : item))
}

/** The slot a dragged tab lands in: one per neighbour whose centre its centre has passed. */
export function dropIndexFor(slots: readonly Slot[], from: number, deltaX: number): number {
  const dragged = slots[from]
  const centre = dragged.left + dragged.width / 2 + deltaX
  let index = from
  for (let i = from + 1; i < slots.length && centre > slots[i].left + slots[i].width / 2; i++) {
    index = i
  }
  for (let i = from - 1; i >= 0 && centre < slots[i].left + slots[i].width / 2; i--) {
    index = i
  }
  return index
}

/** How far a neighbour slides while a tab is dragged from `from` towards `to`. */
export function shiftForNeighbour(index: number, from: number, to: number, step: number): number {
  if (from < to && index > from && index <= to) return -step
  if (to < from && index >= to && index < from) return step
  return 0
}
