import { agentLabel } from '../agentProviders'
import { type AgentType, type Group, isShellAgentType, type Project, type SubTab } from '../types'

export type VoiceTarget = {
  ptyId: string
  projectId: string
  terminalId: string
  /** The sub-tab of the pane that runs this agent; only the tab in front mounts a terminal. */
  tabId: string
  /** This agent is the pane's tab in front. */
  tabActive: boolean
  /** The harness in the tab: Claude Code, Codex, OpenCode, a custom agent… never a shell. */
  agent: AgentType
  label: string
  cwd: string
  sessionId: string | null
}

/** Claude Code is the only harness whose hooks report tools, permissions and the end of a turn. */
export const hasVoiceHooks = (agent: AgentType) => agent === 'claude'

/**
 * Every running agent a voice turn can reach, in any tab of any pane of a non-archived project,
 * in project order, then pane, then tab. Shell tabs are left out: nobody answers there.
 */
export function listAgentTargets(
  projects: Project[],
  alive: (ptyId: string, agent: AgentType) => boolean,
): VoiceTarget[] {
  const targets: VoiceTarget[] = []
  for (const project of projects) {
    if (project.archived) continue
    for (const terminal of project.terminals) {
      if (terminal.kind && terminal.kind !== 'terminal') continue
      const frontTabId = terminal.tabs.some((item) => item.id === terminal.activeTabId)
        ? terminal.activeTabId
        : terminal.tabs[0]?.id
      const tabs = terminal.tabs.filter(
        (tab) => !isShellAgentType(tab.type) && tab.ptyId && alive(tab.ptyId, tab.type),
      )
      const paneLabel = `${project.name} · ${terminal.name}`
      tabs.forEach((tab, index) => {
        targets.push({
          ptyId: tab.ptyId as string,
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          tabActive: tab.id === frontTabId,
          agent: tab.type,
          label: withAgentName(
            tabs.length > 1 ? `${paneLabel} · ${tabName(tabs, index)}` : paneLabel,
            tab.type,
          ),
          cwd: tab.cwd || terminal.cwd,
          sessionId: tab.sessionId ?? null,
        })
      })
    }
  }
  return targets
}

/** Several harnesses can be picked: the label says which one runs there, unless it already does. */
function withAgentName(label: string, agent: AgentType): string {
  const name = agentLabel(agent)
  const lower = label.toLowerCase()
  return lower.includes(name.toLowerCase()) || lower.includes(agent.toLowerCase())
    ? label
    : `${label} · ${name}`
}

/** Tells agent sessions of one pane apart; an empty or shared name gets its position. */
function tabName(tabs: SubTab[], index: number): string {
  const name = tabs[index].name.trim()
  const shared = !name || tabs.some((tab, other) => other !== index && tab.name.trim() === name)
  return shared ? `${name || agentLabel(tabs[index].type)} ${index + 1}` : name
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
 * Other harnesses have no such hooks: any running one is a target, driven through its terminal.
 */
export function voiceTargetable(
  runtime: Record<string, { alive?: boolean } | undefined>,
  hookedPtyIds: readonly string[],
): (ptyId: string, agent: AgentType) => boolean {
  const hooked = new Set(hookedPtyIds)
  return (ptyId, agent) =>
    Boolean(runtime[ptyId]?.alive) && (!hasVoiceHooks(agent) || hooked.has(ptyId))
}

/**
 * The other side of `voiceTargetable`: a live Claude launched without the voice hooks (voice was
 * off then). It can only be offered a restart, which relaunches it with them.
 */
export function voiceRestartable(
  runtime: Record<string, { alive?: boolean } | undefined>,
  hookedPtyIds: readonly string[],
): (ptyId: string, agent: AgentType) => boolean {
  const hooked = new Set(hookedPtyIds)
  return (ptyId, agent) =>
    Boolean(runtime[ptyId]?.alive) && hasVoiceHooks(agent) && !hooked.has(ptyId)
}

/**
 * Running Claude sessions without the voice hooks that a restart can fix, in `projects` order. A
 * disabled pane is left out, as its own restart button is off. The picker, the "restart needed"
 * toast and Restart now all use this list.
 */
export function staleSessions(
  projects: Project[],
  runtime: Record<string, { alive?: boolean } | undefined>,
  hookedPtyIds: readonly string[],
): VoiceTarget[] {
  const disabled = new Set(
    projects.flatMap((project) =>
      project.terminals.filter((terminal) => terminal.disabled).map((terminal) => terminal.id),
    ),
  )
  return listAgentTargets(projects, voiceRestartable(runtime, hookedPtyIds)).filter(
    (session) => !disabled.has(session.terminalId),
  )
}

/**
 * A session the person picked, else the active pane when an agent is its tab in front, else the
 * last agent pane used, else the only agent in front, else the only session at all.
 */
export function resolveTarget(
  candidates: VoiceTarget[],
  context: {
    pinnedPtyId: string | null
    activeTerminalId: string | null
    lastAgentPtyId: string | null
  },
): VoiceTarget | null {
  const byPty = (id: string | null) =>
    id ? candidates.find((item) => item.ptyId === id) : undefined
  const front = candidates.filter((item) => item.tabActive)
  return (
    byPty(context.pinnedPtyId) ??
    front.find((item) => item.terminalId === context.activeTerminalId) ??
    byPty(context.lastAgentPtyId) ??
    // A lone agent in front wins over sessions waiting in background tabs.
    (front.length === 1 ? front[0] : candidates.length === 1 ? candidates[0] : null)
  )
}
