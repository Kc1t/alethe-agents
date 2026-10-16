import type { Project } from '../types'

export type VoiceTarget = {
  ptyId: string
  projectId: string
  terminalId: string
  label: string
  cwd: string
  sessionId: string | null
}

export function listClaudeTargets(
  projects: Project[],
  alive: (ptyId: string) => boolean,
): VoiceTarget[] {
  const targets: VoiceTarget[] = []
  for (const project of projects) {
    if (project.archived) continue
    for (const terminal of project.terminals) {
      if (terminal.kind && terminal.kind !== 'terminal') continue
      const tab = terminal.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal.tabs[0]
      if (!tab || tab.type !== 'claude' || !tab.ptyId || !alive(tab.ptyId)) continue
      targets.push({
        ptyId: tab.ptyId,
        projectId: project.id,
        terminalId: terminal.id,
        label: `${project.name} · ${terminal.name}`,
        cwd: tab.cwd || terminal.cwd,
        sessionId: tab.sessionId ?? null,
      })
    }
  }
  return targets
}

/**
 * The projects the sidebar shows, in its order: non-archived groups depth-first (sub-groups before
 * the group's own projects), then the ungrouped list, then any project no group lists. Hidden
 * projects and those of an archived group are left out, as the sidebar leaves them out.
 */
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
    // Orphans of an archived or deleted parent show with the root groups.
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

/**
 * The `alive` predicate for voice: the PTY runs, and a Claude was launched with the voice hooks
 * (see `agentVoiceHookedPtys`), without which no permission request or Stop would reach Alethe.
 */
export function voiceTargetable(
  runtime: Record<string, { alive?: boolean } | undefined>,
  hookedPtyIds: readonly string[],
): (ptyId: string) => boolean {
  const hooked = new Set(hookedPtyIds)
  return (ptyId) => Boolean(runtime[ptyId]?.alive) && hooked.has(ptyId)
}

/** A pane the person picked, else the active Claude pane, else the last one used. */
export function resolveTarget(
  candidates: VoiceTarget[],
  context: {
    pinnedPtyId: string | null
    activeTerminalId: string | null
    lastClaudePtyId: string | null
  },
): VoiceTarget | null {
  const byPty = (id: string | null) =>
    id ? candidates.find((item) => item.ptyId === id) : undefined
  const front = candidates.filter((item) => item.tabActive)
  return (
    byPty(context.pinnedPtyId) ??
    candidates.find((item) => item.terminalId === context.activeTerminalId) ??
    byPty(context.lastClaudePtyId) ??
    (candidates.length === 1 ? candidates[0] : null)
  )
}
