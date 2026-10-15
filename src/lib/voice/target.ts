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
 * The `alive` predicate for voice: the PTY runs, and its Claude was launched with the voice hooks
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
  return (
    byPty(context.pinnedPtyId) ??
    candidates.find((item) => item.terminalId === context.activeTerminalId) ??
    byPty(context.lastClaudePtyId) ??
    (candidates.length === 1 ? candidates[0] : null)
  )
}
