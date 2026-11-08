import type { Group, Project } from './types'

// Groups depth-first (sub-groups before the group's own projects), then the ungrouped list.
export function inSidebarOrder(
  projects: Project[],
  groups: Group[],
  ungroupedOrder: string[],
): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  const visible = groups.filter((group) => !group.archived)
  const visibleIds = new Set(visible.map((group) => group.id))
  const children = new Map<string | null, Group[]>()
  for (const group of visible) {
    const parent =
      group.parentGroupId && visibleIds.has(group.parentGroupId) ? group.parentGroupId : null
    children.set(parent, [...(children.get(parent) ?? []), group])
  }
  const archivedGroupProjects = new Set(
    groups.filter((group) => group.archived).flatMap((group) => group.projectIds),
  )
  const ordered: Project[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    const project = byId.get(id)
    if (!project || project.hidden || seen.has(id)) return
    seen.add(id)
    ordered.push(project)
  }
  const walk = (group: Group) => {
    for (const child of children.get(group.id) ?? []) walk(child)
    for (const id of group.projectIds) add(id)
  }
  for (const group of children.get(null) ?? []) walk(group)
  for (const id of ungroupedOrder) add(id)
  for (const project of projects) {
    if (!archivedGroupProjects.has(project.id)) add(project.id)
  }
  return ordered
}
