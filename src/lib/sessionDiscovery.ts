import { normalizeCwd } from './platform'

export type SessionSnapshot = {
  id: string
  modified_at_ms: number
}

const claimedIds = new Map<string, Set<string>>()

const claimOwners = new Map<string, Array<{ key: string; sessionId: string }>>()

function claimKey(agent: string, cwd: string): string {
  return `${agent}\0${normalizeCwd(cwd)}`
}

function trackOwner(ptyId: string | undefined, key: string, sessionId: string): void {
  if (!ptyId) return
  const list = claimOwners.get(ptyId) ?? []
  if (list.some((claim) => claim.key === key && claim.sessionId === sessionId)) return
  list.push({ key, sessionId })
  claimOwners.set(ptyId, list)
}

export function registerSessionClaim(
  agent: string,
  cwd: string,
  sessionId?: string,
  ptyId?: string,
): void {
  if (!sessionId) return
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  claimed.add(sessionId)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, sessionId)
}

export function isSessionClaimed(
  agent: string,
  cwd: string,
  sessionId: string,
  ownerId?: string,
): boolean {
  const key = claimKey(agent, cwd)
  if (!claimedIds.get(key)?.has(sessionId)) return false
  if (!ownerId) return true
  return (
    claimOwners
      .get(ownerId)
      ?.some((claim) => claim.key === key && claim.sessionId === sessionId) !== true
  )
}

function excludeReserved<T extends SessionSnapshot>(
  sessions: readonly T[],
  reservedIds?: ReadonlySet<string>,
): readonly T[] {
  if (!reservedIds || reservedIds.size === 0) return sessions
  return sessions.filter((session) => !reservedIds.has(session.id))
}

/**
 * Atomically claims one new session ID for a single pane. When more than one
 * new session appears between snapshots the pane -> conversation mapping is
 * ambiguous, and persisting nothing is safer than resuming the wrong chat on
 * the next boot.
 *
 * `reservedIds`: session IDs already owned by OTHER tabs/terminals (in any
 * project), read from persisted state by the caller — never candidates here,
 * even when `claimedIds` (in-memory, reset on every app restart) does not know
 * them yet in this run.
 */
export function claimDiscoveredSession(
  agent: string,
  cwd: string,
  beforeIds: ReadonlySet<string>,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
  reservedIds?: ReadonlySet<string>,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  const candidates = excludeReserved(sessions, reservedIds)
    .filter((session) => !beforeIds.has(session.id) && !claimed.has(session.id))
    .sort((a, b) => a.modified_at_ms - b.modified_at_ms)
  if (candidates.length !== 1) return undefined
  const candidate = candidates[0]
  if (!candidate) return undefined
  claimed.add(candidate.id)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, candidate.id)
  return candidate
}

/**
 * Claims the most recent EXISTING session for a cwd no other pane has taken
 * yet. Unlike `claimDiscoveredSession` (which sorts ascending to find NEW
 * sessions in the order they appeared), this wants the newest of all — used
 * before a spawn when no ID is saved but a conversation may already exist for
 * that directory (e.g. reopening a terminal after an app restart).
 *
 * `reservedIds`: see `claimDiscoveredSession` above.
 */
export function claimMostRecentSession(
  agent: string,
  cwd: string,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
  reservedIds?: ReadonlySet<string>,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  const candidate = [...excludeReserved(sessions, reservedIds)]
    .filter((session) => !claimed.has(session.id))
    .sort((a, b) => b.modified_at_ms - a.modified_at_ms)[0]
  if (!candidate) return undefined
  claimed.add(candidate.id)
  claimedIds.set(key, claimed)
  trackOwner(ptyId, key, candidate.id)
  return candidate
}

export function releaseSessionClaim(ptyId: string): void {
  const owned = claimOwners.get(ptyId)
  if (!owned) return
  claimOwners.delete(ptyId)
  for (const { key, sessionId } of owned) {
    // A tab and its live PTY can both own the same claim. Releasing either must
    // not make the conversation available while the other owner still holds it.
    if (
      [...claimOwners.values()].some((claims) =>
        claims.some((claim) => claim.key === key && claim.sessionId === sessionId),
      )
    )
      continue
    const set = claimedIds.get(key)
    if (!set) continue
    set.delete(sessionId)
    if (set.size === 0) claimedIds.delete(key)
  }
}

export function resetSessionClaimsForTests(): void {
  claimedIds.clear()
  claimOwners.clear()
}
