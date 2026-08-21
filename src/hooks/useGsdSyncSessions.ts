import { useEffect, useMemo, useRef } from 'react'
import { create } from 'zustand'

import { readGsdChildBusy, readGsdChildError, readGsdChildSession } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

export type GsdSyncSession = {
  id: string
  projectId: string
  /** Worktree folder the child session runs in — used directly as the data
   *  source (`opencode export`), with no PTY terminal in between. */
  worktreePath: string
  childId: string
  busy: boolean
  hasError: boolean
}

type WatchedItem = {
  id: string
  projectId: string
  worktreePath: string
}

// Tiny store, just to have exactly ONE real poll across the whole app
// (SidebarMergePanel AND the GSD Sync drawer show the same data). Without it,
// each `useEffect` calling the hook would run its own 5s poll.
const useGsdSyncSessionsStore = create<{ sessions: GsdSyncSession[] }>(() => ({ sessions: [] }))

/**
 * The sole owner of the real poll (reading `.planning/.gsd-child-session` /
 * `.gsd-child-busy` / `.gsd-child-error` every 5s). Must be called from
 * exactly ONE place that's always mounted (today: `SidebarMergePanel`,
 * mounted unconditionally in the Project Sidebar).
 *
 * Creates no terminal/PTY — the child session runs inside the MAIN
 * terminal's OpenCode process (OpenCode's own internal multi-session
 * mechanism, via the `alethe-gsd-state.ts` plugin), so it doesn't depend on
 * any "viewer" terminal existing. The view (GSD Sync drawer) reads the
 * content directly via `opencode export <childId>` (`GsdSyncActivityView`) —
 * a read-only HTML `<div>`, with no PTY terminal in the path.
 */
export function useGsdSyncSessionsWatcher(
  onChildError?: (session: { projectId: string; worktreePath: string }, message: string) => void,
): void {
  const projects = useProjectsStore((s) => s.projects)

  const pollingRef = useRef<Set<string>>(new Set())
  const onChildErrorRef = useRef(onChildError)
  onChildErrorRef.current = onChildError

  // Same criterion `XTermView` uses to write the GSD plugin (opencode command
  // + cwd + watcher enabled on the project) — no worktree isolation required.
  const watched: WatchedItem[] = useMemo(() => {
    const result: WatchedItem[] = []
    for (const proj of projects) {
      if (!proj.gsdWatcherEnabled) continue
      for (const term of proj.terminals) {
        // The ephemeral conflict-resolution agent is never trackable here —
        // the GSD plugin isn't even installed on it (see TerminalPane).
        if (term.ephemeralConflictAgent) continue
        if (term.cwd && term.tabs.some((tab) => tab.type === 'opencode')) {
          result.push({ id: `${proj.id}-${term.id}`, projectId: proj.id, worktreePath: term.cwd })
        }
      }
    }
    return result
  }, [projects])

  useEffect(() => {
    if (watched.length === 0) {
      useGsdSyncSessionsStore.setState({ sessions: [] })
      return
    }

    const poll = async () => {
      // Read fresh on every tick (not as an effect dependency) for the usual
      // reason: avoid rescheduling the poll on every state mutation.
      const { projects } = useProjectsStore.getState()
      const next: GsdSyncSession[] = []
      // Ids this poll actually resolved (session found OR confirmed absent) —
      // used to decide what to remove from the shared store without wiping
      // entries for items an overlapping poll is still processing.
      const resolvedIds = new Set<string>()
      for (const item of watched) {
        // Synchronous guard before any await — avoids reentrancy when two
        // `poll()` calls overlap.
        if (pollingRef.current.has(item.id)) continue
        pollingRef.current.add(item.id)
        try {
          const childId = await readGsdChildSession(item.worktreePath).catch(() => null)
          if (!childId) {
            resolvedIds.add(item.id)
            continue
          }
          const proj = projects.find((p) => p.id === item.projectId)
          if (!proj) {
            resolvedIds.add(item.id)
            continue
          }

          const busy = await readGsdChildBusy(item.worktreePath).catch(() => false)
          const childError = await readGsdChildError(item.worktreePath).catch(() => null)
          if (childError) {
            onChildErrorRef.current?.(
              { projectId: item.projectId, worktreePath: item.worktreePath },
              childError,
            )
          }

          resolvedIds.add(item.id)
          next.push({
            id: item.id,
            projectId: item.projectId,
            worktreePath: item.worktreePath,
            childId,
            busy,
            hasError: Boolean(childError),
          })
        } catch (error) {
          // Without this, a failure escaped the whole loop as an unhandled
          // rejection — aborting the rest of `watched` for THIS tick, not
          // just this item. Doesn't mark `resolvedIds` for this item: retries
          // on its own on the next 5s tick.
          console.error(`[gsd-sync] failed processing ${item.id}:`, error)
        } finally {
          pollingRef.current.delete(item.id)
        }
      }
      // Merge by id instead of full replacement: preserves entries for items
      // an OVERLAPPING poll is still processing, updates/removes only what
      // this poll actually resolved, and drops any entry whose worktree no
      // longer exists in `watched`.
      useGsdSyncSessionsStore.setState((state) => {
        const byId = new Map(state.sessions.map((session) => [session.id, session]))
        for (const session of next) byId.set(session.id, session)
        for (const id of resolvedIds) {
          if (!next.some((session) => session.id === id)) byId.delete(id)
        }
        const watchedIds = new Set(watched.map((item) => item.id))
        return { sessions: [...byId.values()].filter((session) => watchedIds.has(session.id)) }
      })
    }

    void poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [watched])
}

export function useGsdSyncSessions(): GsdSyncSession[] {
  return useGsdSyncSessionsStore((s) => s.sessions)
}
