/**
 * Descoberta e persistência do ID de sessão pós-spawn, pra agentes que não
 * permitem escolher o ID no nascimento (Codex, Antigravity, OpenCode — ao
 * contrário do Claude, cujo ID é conhecido sincronamente no spawn).
 *
 * Extraído de `useXtermSession.ts` (era o `detectCreatedSession` inline do
 * efeito de mount/spawn) pra ser reusável por qualquer caminho que reinicie
 * uma PTY existente (restart manual, migração pra worktree) sem precisar
 * remontar o componente XTermView — ver `agentPtyRestart.ts`.
 */
import {
  claimDiscoveredSession,
  claimMostRecentSession,
  type SessionSnapshot,
} from './sessionDiscovery'
import { saveSession } from './sessionResume'
import { waitForSessionHint } from './sessionWatch'
import {
  snapshotAntigravitySessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
} from './tauri'

export type AsyncResumableAgent = 'codex' | 'antigravity' | 'opencode'

async function snapshotFor(agent: AsyncResumableAgent, cwd: string): Promise<SessionSnapshot[]> {
  if (agent === 'codex') return snapshotCodexSessions(cwd).catch(() => [])
  if (agent === 'antigravity') return snapshotAntigravitySessions(cwd).catch(() => [])
  return snapshotOpenCodeSessions(cwd).catch(() => [])
}

/**
 * Checagem SÍNCRONA (uma tentativa só, sem polling) da sessão mais recente
 * já existente em disco pra este (agent, cwd) — pra usar em momentos que não
 * podem esperar `watchAndPersistDiscoveredSession` (que só tenta a cada 3s+
 * em segundo plano). Bug real, confirmado ao vivo: mover um terminal pra
 * worktree nova depois de um merge ("manter sessão") matava o processo e
 * relia só no cache de `localStorage` (`getActiveSessions`/`saveSession`) —
 * se o watcher ainda não tinha achado a sessão real do CLI (mínimo ~3s de
 * atraso, e só depois do agente responder pelo menos uma vez), o cache
 * nunca tinha nada, e a retomada sempre caía numa conversa vazia mesmo com
 * uma sessão de verdade esperando em disco. Persiste no `saveSession` se
 * achar algo, pra o resto do app (próximo boot, outras checagens) já ver a
 * entrada certa também.
 */
export async function discoverActiveSessionNow(
  agent: AsyncResumableAgent,
  cwd: string,
  ptyId?: string,
  reservedIds?: ReadonlySet<string>,
): Promise<string | undefined> {
  const sessions = await snapshotFor(agent, cwd)
  const claimed = claimMostRecentSession(agent, cwd, sessions, ptyId, reservedIds)
  if (!claimed) return undefined
  if (ptyId) {
    saveSession(ptyId, {
      sessionId: ptyId,
      codexSessionId: agent === 'codex' ? claimed.id : undefined,
      antigravitySessionId: agent === 'antigravity' ? claimed.id : undefined,
      opencodeSessionId: agent === 'opencode' ? claimed.id : undefined,
      cwd,
      agent,
      timestamp: Date.now(),
    })
  }
  return claimed.id
}

export type WatchAndPersistDiscoveredSessionOpts = {
  agent: AsyncResumableAgent
  cwd: string
  /** Chave de persistência (`sessionKey ?? ptyId` no hook; `tab.id` fora dele). */
  sessionPersistenceKey: string
  /** ID real da PTY já spawnada (`response.id`) — usado pra `saveSession`. */
  spawnedPtyId: string
  /** Snapshot de sessões já existentes ANTES do spawn, pra diferenciar a nova. */
  discoveredSessionsBeforePromise: Promise<SessionSnapshot[]>
  /** Substitui a variável de closure `disposed` do hook. */
  isCancelled: () => boolean
  onSessionId?: (id: string) => void
  /** SessionIds já pertencentes a outras abas (qualquer projeto) — nunca
   *  viram candidato de claim aqui, mesmo que ainda não tenham sido
   *  reivindicados nesta execução do app. Ver `sessionDiscovery.ts`. */
  reservedIds?: ReadonlySet<string>
}

/**
 * Faz polling até achar a sessão recém-criada pelo agente (ou o chamador
 * cancelar via `isCancelled`), persistindo o ID assim que encontrar. Mesmo
 * cadenciamento de antes: tentativas rápidas (3s) nos primeiros ~30s, depois
 * espaçadas (15s) — sem prazo fixo amarrado ao spawn, porque o que decide
 * quando o arquivo de sessão do CLI existe é quando o agente termina de
 * responder a primeira mensagem, não quando o processo nasceu.
 */
export async function watchAndPersistDiscoveredSession(
  opts: WatchAndPersistDiscoveredSessionOpts,
): Promise<void> {
  const {
    agent,
    cwd,
    sessionPersistenceKey,
    spawnedPtyId,
    discoveredSessionsBeforePromise,
    isCancelled,
    onSessionId,
    reservedIds,
  } = opts
  const before = new Set((await discoveredSessionsBeforePromise).map((s) => s.id))
  let attempt = 0
  while (!isCancelled()) {
    const delayMs = attempt < 10 ? 3000 : 15000
    if (agent === 'codex') {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, delayMs)),
        waitForSessionHint('codex'),
      ])
    } else {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    if (isCancelled()) return
    const sessions = await snapshotFor(agent, cwd)
    const newSession = claimDiscoveredSession(
      agent,
      cwd,
      before,
      sessions,
      spawnedPtyId,
      reservedIds,
    )
    if (newSession) {
      saveSession(sessionPersistenceKey, {
        sessionId: spawnedPtyId,
        codexSessionId: agent === 'codex' ? newSession.id : undefined,
        antigravitySessionId: agent === 'antigravity' ? newSession.id : undefined,
        opencodeSessionId: agent === 'opencode' ? newSession.id : undefined,
        cwd,
        agent,
        timestamp: Date.now(),
      })
      onSessionId?.(newSession.id)
      return
    }
    attempt += 1
  }
}
