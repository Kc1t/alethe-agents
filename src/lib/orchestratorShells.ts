import type { OrchestratorShell, OrchestratorShellStatus } from './tauri/orchestrator'

/** The orchestrator's PTY ids; `pty_id_for` in `orchestrator_shells.rs` builds them. */
const PTY_PREFIX = 'orchestrator-'
const SHELL_PTY_PREFIX = `${PTY_PREFIX}shell-`

export function isOrchestratorShellPty(ptyId: string): boolean {
  return ptyId.startsWith(SHELL_PTY_PREFIX)
}

export function shellIdOfPty(ptyId: string): string {
  return ptyId.slice(PTY_PREFIX.length)
}

export type ShellControl = 'stop' | 'restart' | 'play' | 'openTerminal' | 'remove'

/** A finished shell has no PTY left to attach to, so it is never offered as a terminal. */
export function shellControls(status: OrchestratorShellStatus): ShellControl[] {
  return status === 'running' ? ['stop', 'restart', 'openTerminal'] : ['play', 'remove']
}

export type ShellsForBoardParams = {
  /** The board's current tab, if any: that planner's shells show regardless of cwd. */
  activePlannerId: string | null
  /** Planners of the groups on screen right now — a shell of one of these stays under its own tab. */
  livePlannerIds: ReadonlySet<string>
  /** The project's default cwd, or null when it has none. */
  projectCwd: string | null
}

export type ShellAttachment = 'attached' | 'detached'

/** A shell as the board sees it: `attached` hangs off the planner node, `detached` stands alone. */
export type BoardShell = OrchestratorShell & { attachment: ShellAttachment }

/**
 * Which shells the board shows: the active planner's own, plus any shell whose owner is gone (or
 * never recorded) and whose cwd falls under this project — the same fallback the jobs filter uses,
 * so a `docker compose up` is never dropped just because the planner that started it closed.
 */
export function shellsForBoard(
  shells: readonly OrchestratorShell[],
  { activePlannerId, livePlannerIds, projectCwd }: ShellsForBoardParams,
): BoardShell[] {
  const board: BoardShell[] = []
  for (const shell of shells) {
    const ownerId = shell.owner?.id ?? null
    if (activePlannerId !== null && ownerId === activePlannerId) {
      board.push({ ...shell, attachment: 'attached' })
      continue
    }
    if (ownerId !== null && livePlannerIds.has(ownerId)) continue
    if (projectCwd === null || shell.cwd.startsWith(projectCwd)) {
      board.push({ ...shell, attachment: 'detached' })
    }
  }
  return board
}

export type PlannerTabActivity = {
  /** Delegated jobs plus this planner's own shells still running - 0 means nothing to show. */
  count: number
  /** Whether this planner's own terminal is alive right now, independent of its jobs' states. */
  live: boolean
}

/**
 * What a planner's tab shows: liveness comes from its own terminal, never from the jobs it
 * delegated (a planner with zero jobs, or every job finished, is not "disconnected"). The count is
 * its delegated jobs plus the shells it owns that are still running, so an idle planner watching a
 * dev server it opened does not read as carrying no load at all.
 */
export function plannerTabActivity(
  jobCount: number,
  shells: readonly OrchestratorShell[],
  plannerId: string | null,
  terminalAlive: boolean,
): PlannerTabActivity {
  if (plannerId === null) return { count: jobCount, live: false }
  const ownRunningShells = shells.filter(
    (shell) => (shell.owner?.id ?? null) === plannerId && shell.status === 'running',
  ).length
  return { count: jobCount + ownRunningShells, live: terminalAlive }
}

export type ShellTerminalTab = { id: string; ptyId: string | null }
export type ShellTerminalLike = { id: string; tabs: readonly ShellTerminalTab[] }

export type ShellTerminalPlan =
  | { action: 'reuse'; terminalId: string; tabId: string }
  /** No live terminal to attach to; `staleTerminalId`, if any, should be dropped first. */
  | { action: 'create'; staleTerminalId: string | null }

/**
 * Whether "open terminal" can reuse an existing view of this shell, or must open a fresh one. A tab
 * left over from a view that outlived its PTY (e.g. across an app restart) never spawns a new
 * process under the shell's id — see `useXtermSession`'s `viewGone` branch — so reusing it would
 * strand the person on a tab that can never come back to life.
 */
export function shellTerminalPlan(
  terminals: readonly ShellTerminalLike[],
  shell: Pick<OrchestratorShell, 'ptyId'>,
  hasLiveRuntime: (ptyId: string) => boolean,
): ShellTerminalPlan {
  for (const terminal of terminals) {
    const tab = terminal.tabs.find((candidate) => candidate.ptyId === shell.ptyId)
    if (!tab) continue
    if (hasLiveRuntime(shell.ptyId)) {
      return { action: 'reuse', terminalId: terminal.id, tabId: tab.id }
    }
    return { action: 'create', staleTerminalId: terminal.id }
  }
  return { action: 'create', staleTerminalId: null }
}
