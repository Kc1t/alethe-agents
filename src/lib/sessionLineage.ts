import type { SubTab } from './types'

export const MAX_SESSION_LINEAGE = 10

/** Records the conversation a tab leaves behind, newest first, so it can be found or restored. */
export function withSessionLineage(tab: SubTab, nextSessionId: string | undefined): SubTab {
  if (tab.sessionId === nextSessionId) return tab
  const kept = (tab.previousSessionIds ?? []).filter(
    (id) => id !== nextSessionId && id !== tab.sessionId,
  )
  const previousSessionIds = (tab.sessionId ? [tab.sessionId, ...kept] : kept).slice(
    0,
    MAX_SESSION_LINEAGE,
  )
  return {
    ...tab,
    sessionId: nextSessionId,
    previousSessionIds: previousSessionIds.length ? previousSessionIds : undefined,
  }
}

export function firstUnclaimedSession(
  candidates: readonly string[] | undefined,
  isClaimed: (sessionId: string) => boolean,
): string | undefined {
  return candidates?.find((id) => !isClaimed(id))
}

export type TabSessionMark = 'current' | 'previous'

/** Puts the tab's current chat first, then its earlier ones newest first, then the rest as given. */
export function orderByTabLineage<T extends { id: string }>(
  sessions: readonly T[],
  currentId: string | undefined,
  previousIds: readonly string[] | undefined,
): Array<{ session: T; mark?: TabSessionMark }> {
  const lineage = [currentId, ...(previousIds ?? [])].filter((id): id is string => Boolean(id))
  const rank = (id: string) => {
    const index = lineage.indexOf(id)
    return index === -1 ? lineage.length : index
  }
  return sessions
    .map((session, index) => ({ session, index, rank: rank(session.id) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ session, rank: position }) => ({
      session,
      mark:
        position === lineage.length
          ? undefined
          : position === 0 && currentId
            ? 'current'
            : 'previous',
    }))
}
