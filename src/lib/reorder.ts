/**
 * Moves one item of a list to another position, returning a new list. An index outside the list is
 * clamped, and a move that changes nothing returns the list it was given.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const last = list.length - 1
  if (from < 0 || from > last) return [...list]
  const target = Math.min(last, Math.max(0, to))
  if (target === from) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}
