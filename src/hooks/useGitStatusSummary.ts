import { useEffect, useRef, useState } from 'react'

import { gitStatus } from '../lib/tauri'

export const GIT_REFRESH_EVENT = 'alethe:git-refresh'

export function notifyGitChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(GIT_REFRESH_EVENT))
  }
}

export function formatGitChangeCount(count: number): string {
  if (count <= 0 || !Number.isFinite(count)) return ''
  if (count < 1000) return String(Math.floor(count))
  const thousands = Math.floor(count / 1000)
  return `${thousands}K+`
}

export type GitStatusSummary = {
  total: number
  staged: number
  changes: number
  untracked: number
  conflicts: number
  branch: string | null
  detached: boolean
  ahead: number
  behind: number
  formatted: string
  hasRepo: boolean
  loading: boolean
}

const initialSummary: GitStatusSummary = {
  total: 0,
  staged: 0,
  changes: 0,
  untracked: 0,
  conflicts: 0,
  branch: null,
  detached: false,
  ahead: 0,
  behind: 0,
  formatted: '',
  hasRepo: false,
  loading: false,
}

// In-flight promise cache to avoid redundant IPC calls for the same CWD
const inflightQueries = new Map<string, Promise<GitStatusSummary>>()
const cachedSummaries = new Map<string, GitStatusSummary>()

export async function fetchGitStatusSummary(cwd: string): Promise<GitStatusSummary> {
  if (!cwd) return initialSummary
  const inflight = inflightQueries.get(cwd)
  if (inflight) return inflight

  const promise = (async () => {
    try {
      const status = await gitStatus(cwd)
      const staged = status.staged?.length ?? 0
      const changes = status.changes?.length ?? 0
      const untracked = status.untracked?.length ?? 0
      const conflicts = status.conflicts?.length ?? 0
      const total = staged + changes + untracked + conflicts

      const result: GitStatusSummary = {
        total,
        staged,
        changes,
        untracked,
        conflicts,
        branch: status.branch || null,
        detached: !!status.detached,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
        formatted: formatGitChangeCount(total),
        hasRepo: true,
        loading: false,
      }
      cachedSummaries.set(cwd, result)
      return result
    } catch {
      const result: GitStatusSummary = {
        ...initialSummary,
        hasRepo: false,
        loading: false,
      }
      cachedSummaries.set(cwd, result)
      return result
    } finally {
      inflightQueries.delete(cwd)
    }
  })()

  inflightQueries.set(cwd, promise)
  return promise
}

export function useGitStatusSummary(cwd?: string, pollIntervalMs = 3500): GitStatusSummary {
  const [summary, setSummary] = useState<GitStatusSummary>(() =>
    cwd ? (cachedSummaries.get(cwd) ?? initialSummary) : initialSummary,
  )
  const lastCwdRef = useRef<string | undefined>(cwd)

  useEffect(() => {
    lastCwdRef.current = cwd
    if (!cwd) {
      setSummary(initialSummary)
      return
    }

    let alive = true

    const update = async () => {
      if (!cwd || !alive) return
      const res = await fetchGitStatusSummary(cwd)
      if (alive && lastCwdRef.current === cwd) {
        setSummary(res)
      }
    }

    // Run initial fetch
    void update()

    // Periodically poll when window is visible
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void update()
      }
    }, pollIntervalMs)

    // Refresh on focus or custom notification
    const onFocusOrEvent = () => void update()
    window.addEventListener('focus', onFocusOrEvent)
    window.addEventListener(GIT_REFRESH_EVENT, onFocusOrEvent)

    return () => {
      alive = false
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocusOrEvent)
      window.removeEventListener(GIT_REFRESH_EVENT, onFocusOrEvent)
    }
  }, [cwd, pollIntervalMs])

  return summary
}
