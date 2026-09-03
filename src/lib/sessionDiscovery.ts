export type SessionSnapshot = {
  id: string
  modified_at_ms: number
}

const claimedIds = new Map<string, Set<string>>()
                                                                                                   
const claimOwners = new Map<string, Array<{ key: string; sessionId: string }>>()

function claimKey(agent: string, cwd: string): string {
  return `${agent}\0${cwd.toLowerCase()}`
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
  return claimOwners.get(ownerId)?.some((claim) => claim.key === key && claim.sessionId === sessionId) !== true
}

   
                                                                            
                                                                            
                                                                          
   
/**
 * The session a pane moved to when the CLI switched conversation under it — an in-CLI `/clear` or
 * `/resume` leaves no other trace than a sibling file that is now newer than the pane's own.
 *
 * A session another pane already claims is never a candidate: two panes on the same folder are
 * always writing newer-than-each-other files, and without this guard the idle one adopts whatever
 * its neighbour is typing into, collapsing both rows onto a single conversation.
 */
export function pickSwitchedSession(
  agent: string,
  cwd: string,
  current: SessionSnapshot | undefined,
  sessions: readonly SessionSnapshot[],
  ownerId?: string,
): SessionSnapshot | undefined {
  if (!current) return undefined
  const candidates = sessions.filter(
    (session) =>
      session.id !== current.id &&
      session.modified_at_ms > current.modified_at_ms &&
      !isSessionClaimed(agent, cwd, session.id, ownerId),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

export function claimDiscoveredSession(
  agent: string,
  cwd: string,
  beforeIds: ReadonlySet<string>,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  const candidates = sessions
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

   
                                                                          
                                                                            
                                                                       
                                                                            
                                                                            
                                      
   
export function claimMostRecentSession(
  agent: string,
  cwd: string,
  sessions: readonly SessionSnapshot[],
  ptyId?: string,
): SessionSnapshot | undefined {
  const key = claimKey(agent, cwd)
  const claimed = claimedIds.get(key) ?? new Set<string>()
  const candidate = [...sessions]
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
