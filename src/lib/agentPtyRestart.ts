/**
 * Caminho único pra reiniciar uma PTY de agente já existente (botão
 * "Reiniciar" do menu de contexto, migração pra worktree) preservando a
 * continuidade de sessão — composto só de peças que já existem
 * (`preparePtyRuntimeLaunch`, `buildAgentLaunch`, `restartPty`,
 * `watchAndPersistDiscoveredSession`), sem reimplementar nada.
 *
 * Antes desta extração, cada call site de `restartPty` (TerminalPane,
 * migração de worktree, menus da sidebar, inspector) reimplementava essa
 * lógica de forma parcial/inconsistente — em vários lugares faltando o
 * `saveSession` completo (ex.: sem `opencodeSessionId`) ou a descoberta
 * pós-spawn pros providers assíncronos (Codex/Antigravity/OpenCode não
 * retornam o ID da sessão sincronamente no spawn).
 *
 * Não força o efeito de mount do `useXtermSession` a re-rodar — isso
 * reintroduziria a corrida que `restart_pty` (Rust) e
 * `useTerminalsStore.beginRestart`/`expectedOldExits` já resolvem hoje: no
 * meio de um restart, `existingRuntime.alive` (marcado otimisticamente por
 * `beginRestart`) faria o hook tomar o atalho de "anexar a sessão viva" em
 * vez de spawnar, que nunca dispara a descoberta.
 */
import { watchAndPersistDiscoveredSession, type AsyncResumableAgent } from './agentSessionDiscovery'
import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { buildAgentLaunch } from './sessionLaunch'
import { saveSession } from './sessionResume'
import {
  restartPty,
  snapshotAntigravitySessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
} from './tauri'
import { agentCliCommand, type AgentRuntimeProfile, type AgentType } from './types'
import { useTerminalsStore } from '../stores/terminalsStore'

const ASYNC_RESUMABLE_AGENTS: ReadonlySet<AgentType> = new Set(['codex', 'antigravity', 'opencode'])
const RESUMABLE_AGENTS: ReadonlySet<AgentType> = new Set(['claude', 'codex', 'opencode', 'antigravity'])

function isAsyncResumable(agent: AgentType): agent is AsyncResumableAgent {
  return ASYNC_RESUMABLE_AGENTS.has(agent)
}

async function snapshotBefore(agent: AsyncResumableAgent, cwd: string) {
  if (agent === 'codex') return snapshotCodexSessions(cwd).catch(() => [])
  if (agent === 'antigravity') return snapshotAntigravitySessions(cwd).catch(() => [])
  return snapshotOpenCodeSessions(cwd).catch(() => [])
}

export type RestartAgentPtyOpts = {
  ptyId: string
  /** Mesma chave que `useXtermSession` usa (`sessionKey ?? ptyId` — na prática `tab.id`). */
  sessionPersistenceKey: string
  agent: AgentType
  cwd: string
  runtimeProfile?: AgentRuntimeProfile
  extraArgs?: string[]
  /** ID de sessão pra retomar, se algum já foi resolvido pelo chamador (ex.: via `savedConversationIdFor`). */
  resumeId?: string
  onSessionId?: (id: string) => void
}

export type RestartAgentPtyResult = {
  id: string
  sessionId?: string
}

export async function restartAgentPty(opts: RestartAgentPtyOpts): Promise<RestartAgentPtyResult> {
  const { ptyId, sessionPersistenceKey, agent, cwd, runtimeProfile, extraArgs, resumeId, onSessionId } = opts

  const preparedRuntime = preparePtyRuntimeLaunch(agent, runtimeProfile, extraArgs ?? [])
  const launch = buildAgentLaunch(agent, preparedRuntime.args, resumeId)

  // Snapshot pré-spawn pros 3 providers assíncronos, só quando ainda não
  // temos um sessionId conhecido — mesma condição do hook (`useXtermSession`).
  const discoveredSessionsBeforePromise =
    isAsyncResumable(agent) && !launch.sessionId ? snapshotBefore(agent, cwd) : null

  useTerminalsStore.getState().beginRestart(ptyId)
  const response = await restartPty({
    id: ptyId,
    cols: 80,
    rows: 24,
    command: agentCliCommand(agent),
    cwd: cwd || undefined,
    extraArgs: launch.args,
    env: preparedRuntime.env,
  })

  if (launch.sessionId) onSessionId?.(launch.sessionId)

  if (RESUMABLE_AGENTS.has(agent)) {
    saveSession(sessionPersistenceKey, {
      sessionId: response.id,
      claudeSessionId: agent === 'claude' ? launch.sessionId : undefined,
      codexSessionId: agent === 'codex' ? launch.sessionId : undefined,
      opencodeSessionId: agent === 'opencode' ? launch.sessionId : undefined,
      antigravitySessionId: agent === 'antigravity' ? launch.sessionId : undefined,
      cwd,
      agent,
      timestamp: Date.now(),
    })

    if (discoveredSessionsBeforePromise && isAsyncResumable(agent)) {
      void watchAndPersistDiscoveredSession({
        agent,
        cwd,
        sessionPersistenceKey,
        spawnedPtyId: response.id,
        discoveredSessionsBeforePromise,
        // Sem componente React aqui pra checar "desmontou" — cancela quando
        // o pty deixa de ser o mesmo processo vivo rastreado pela store
        // (ex.: outro restart substituiu este antes da descoberta terminar).
        isCancelled: () => useTerminalsStore.getState().byPtyId[response.id]?.alive !== true,
        onSessionId,
      })
    }
  }

  return { id: response.id, sessionId: launch.sessionId }
}
