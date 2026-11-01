import type { Group } from './types'

export type GroupMoveTarget = { id: string; label: string }

/** The groups a project can move to, in sidebar order, nested ones labelled with their path. */
export function groupMoveTargets(
  groups: Group[],
  currentGroupId: string | null,
): GroupMoveTarget[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const label = (group: Group) => {
    const names = [group.name]
    const seen = new Set([group.id])
    let parent = group.parentGroupId ? byId.get(group.parentGroupId) : undefined
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id)
      names.unshift(parent.name)
      parent = parent.parentGroupId ? byId.get(parent.parentGroupId) : undefined
    }
    return names.join(' / ')
  }
  return groups
    .filter((group) => group.id !== currentGroupId)
    .map((group) => ({ id: group.id, label: label(group) }))
}
