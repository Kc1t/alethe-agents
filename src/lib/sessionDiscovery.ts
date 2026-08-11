export type SessionSnapshot = {
  id: string
  modified_at_ms: number
}

const claimedIds = new Map<string, Set<string>>()
/** ptyId → claims que ele fez, para eviction quando o PTY fecha (evita crescimento sem limite). */
const claimOwners = new Map<string, Array<{ key: string; sessionId: string }>>()

function claimKey(agent: string, cwd: string): string {
  return `${agent}\0${cwd.toLowerCase()}`
}

function trackOwner(ptyId: string | undefined, key: string, sessionId: string): void {
  if (!ptyId) return
  const list = claimOwners.get(ptyId) ?? []
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
 * Reserva atomicamente um ID novo para um único pane. Se mais de uma sessão
 * aparecer entre snapshots, a associação pane -> conversa ficou ambígua e é
 * melhor não persistir nada do que retomar o chat errado no próximo boot.
 *
 * `reservedIds`: sessionIds que já pertencem a OUTRAS abas/terminais (de
 * qualquer projeto), lidos direto do estado persistido pelo chamador — nunca
 * viram candidato aqui, mesmo se `claimedIds` (só em memória, reseta a cada
 * restart do app) ainda não sabe deles nesta execução.
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
 * Reivindica a sessão EXISTENTE mais recente pra um cwd que ainda não foi
 * pega por outro pane. Ao contrário de `claimDiscoveredSession` (que ordena
 * ascendente pra achar sessões NOVAS na ordem em que apareceram), aqui
 * queremos a mais recente de todas — usado antes do spawn, quando não temos
 * ID salvo mas pode já existir uma conversa naquele diretório (ex.: reabrir
 * terminal depois de restart do app).
 *
 * `reservedIds`: ver `claimDiscoveredSession` acima.
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

/**
 * Libera os claims feitos por um pane quando seu PTY fecha. Sem isto, o
 * `claimedIds` cresceria monotonicamente (uma entrada por cwd já aberto + um id
 * por sessão já spawnada) pela vida inteira do app. Só remove os ids do próprio
 * ptyId, então não afeta o guard anti-duplo-claim de outros panes vivos.
 */
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
