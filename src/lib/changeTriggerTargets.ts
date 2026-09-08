import type { Project, Terminal } from './types'

/** A live agent conversation the procedure prompt can be typed into. */
export type PromptTarget = {
  terminalId: string
  tabId: string
  ptyId: string
  terminalName: string
  agentType: string
  lastUsedAt: number
}

/**
 * Finds the agent conversations in a project that can receive the prompt.
 *
 * The prompt goes into a terminal that is already running an agent, never into a new one: a
 * procedure describes work someone did, and the agent that did it is the only one holding that
 * context. A fresh session would have to rediscover the change from the diff, which is precisely
 * the guesswork the prompt exists to avoid.
 *
 * Only tabs with a live `ptyId` qualify — a terminal whose process has exited would swallow the
 * prompt with nothing to show for it. Shell tabs are excluded: they would echo the text as a
 * command and fail.
 *
 * Ordered most-recently-used first, which is the app's best guess at "the agent you were talking
 * to". It is only a default; when there is more than one, the choice belongs to the user.
 */
export function resolveAgentPromptTargets(project: Project | undefined): PromptTarget[] {
  if (!project) return []
  const targets: PromptTarget[] = []
  for (const terminal of project.terminals as Terminal[]) {
    for (const tab of terminal.tabs) {
      if (!tab.ptyId || tab.type === 'shell') continue
      targets.push({
        terminalId: terminal.id,
        tabId: tab.id,
        ptyId: tab.ptyId,
        terminalName: terminal.name,
        agentType: tab.type,
        lastUsedAt: tab.lastUsedAt ?? terminal.lastUsedAt ?? 0,
      })
    }
  }
  return targets.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}
