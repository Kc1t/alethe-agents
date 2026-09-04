import type { Group } from './types'

/** Collect all descendant group IDs below `rootId`, tolerating malformed cycles. */
export function collectDescendants(rootId: string, allGroups: Group[]): Set<string> {
  const result = new Set<string>()
  const visited = new Set([rootId])
  const queue = [rootId]

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const group of allGroups) {
      if (group.parentGroupId !== current || visited.has(group.id)) continue
      visited.add(group.id)
      result.add(group.id)
      queue.push(group.id)
    }
  }

  return result
}
