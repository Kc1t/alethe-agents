import type { Project } from './types'

/**
 * The name of the terminal a pty id belongs to, searched across every project.
 *
 * Before a fresh spawn's real pty id is known, the caller runs on the tab's own id as a stand-in
 * (`activeTab.ptyId ?? activeTab.id` in `TerminalPane`) until `onSpawned` fills in the real one, so
 * a tab is matched on either field. Matching on `ptyId` alone misses the tab during that window and
 * the caller falls back to the raw, unreadable id instead of the name the person gave the terminal.
 */
export function terminalNameForPty(projects: readonly Project[], ptyId: string): string | undefined {
  for (const project of projects) {
    for (const terminal of project.terminals) {
      if (terminal.tabs.some((tab) => tab.ptyId === ptyId || tab.id === ptyId)) {
        return terminal.name
      }
    }
  }
  return undefined
}
