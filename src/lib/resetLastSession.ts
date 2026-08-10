/**
 * Reset da última sessão — recuperação manual do resume quando o resume
 * automático falha ao reabrir o app. Para cada painel de agente VIVO, acha a
 * conversa mais recente no disco (pelo cwd) e reinicia o PTY com a flag de
 * resume correta de cada CLI, persistindo o estado pra que os próximos boots
 * também retomem.
 *
 * Reusa o mesmo mecanismo provado do `ClaudeHistoryModal.resumeHere`
 * (restartPty + --resume), generalizado pra toda a workspace.
 */

import { getActiveSessions, saveSession } from './sessionResume'
import { acquireSpawnSlot, releaseSpawnSlot } from './spawnQueue'
import {
  getPtyCwd,
  restartPty,
  snapshotAntigravitySessions,
  snapshotClaudeSessions,
  snapshotCodexSessions,
  snapshotOpenCodeSessions,
} from './tauri'
import type { AgentType } from './types'
import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'

const RESUMABLE: AgentType[] = ['claude', 'codex', 'opencode', 'antigravity']

export type ResetLastSessionResult = { resumed: number; total: number }

/** Remove uma flag `--flag <valor>` (e o valor seguinte) da lista de args. */
function stripFlagWithValue(args: string[], flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++ // pula o valor associado
      continue
    }
    out.push(args[i])
  }
  return out
}

/** Filtro pra escolher a sessão "certa" excluindo a que está rodando agora. */
export type SessionExclude = {
  /** ID da conversa atualmente aberta no pane — não queremos resumir ela. */
  id?: string
  /** Timestamp do spawn atual: preferimos sessões anteriores a ele. */
  before?: number
}

/**
 * Escolhe a conversa a retomar: a mais recente que NÃO é a que está rodando.
 * Se o resume falhou, a CLI já criou uma sessão nova/vazia (a mais recente no
 * disco) — então excluímos o id atual e priorizamos as anteriores ao spawn.
 */
export function pickSessionId(
  sessions: ReadonlyArray<{ id: string; modified_at_ms: number }>,
  exclude: SessionExclude,
): string | null {
  const candidates = sessions.filter((s) => s.id !== exclude.id)
  if (candidates.length === 0) return null
  const older = exclude.before ? candidates.filter((s) => s.modified_at_ms < exclude.before!) : []
  const pool = older.length > 0 ? older : candidates
  return pool.reduce((a, b) => (b.modified_at_ms > a.modified_at_ms ? b : a)).id
}

/** Acha o ID da conversa a retomar no disco para o cwd, por agente. */
async function latestSessionId(
  agent: AgentType,
  cwd: string,
  exclude: SessionExclude,
  savedOpenCodeId?: string,
): Promise<string | null> {
  if (!cwd) return null
  try {
    if (agent === 'codex') return pickSessionId(await snapshotCodexSessions(cwd), exclude)
    if (agent === 'claude') return pickSessionId(await snapshotClaudeSessions(cwd), exclude)
    if (agent === 'opencode') {
      // Estratégia em 3 níveis pra nunca cair no `--continue` global (que
      // pegaria a sessão mais recente de OUTRO projeto):
      // 1) ID já persistido pro pane; 2) snapshot filtrado por cwd no backend;
      // 3) null → --continue como último recurso.
      if (savedOpenCodeId) return savedOpenCodeId
      const sessions = await snapshotOpenCodeSessions(cwd)
      if (sessions.length > 0) {
        return pickSessionId(sessions, exclude) ?? sessions[0].id
      }
      return null
    }
    if (agent === 'antigravity')
      return pickSessionId(await snapshotAntigravitySessions(cwd), exclude)
  } catch {
    return null
  }
  return null
}

/** Monta os args de resume seguindo o mesmo padrão do spawn do XTermView. */
export function buildResumeArgs(
  agent: AgentType,
  baseArgs: string[],
  sessionId: string | null,
): string[] {
  if (agent === 'claude') {
    // Tira qualquer --resume <id> / --continue antigos e reinjeta o novo.
    const clean = stripFlagWithValue(baseArgs, '--resume').filter((a) => a !== '--continue')
    return sessionId ? ['--resume', sessionId, ...clean] : ['--continue', ...clean]
  }
  if (agent === 'codex') {
    // codex usa `resume <id>` / `resume --last` como subcomando (1º arg).
    let clean = baseArgs
    if (baseArgs[0] === 'resume') {
      const rest = baseArgs.slice(1)
      if (rest[0] && (rest[0] === '--last' || !rest[0].startsWith('-'))) rest.shift()
      clean = rest
    }
    return sessionId ? ['resume', sessionId, ...clean] : ['resume', '--last', ...clean]
  }
  if (agent === 'antigravity') {
    const clean = stripFlagWithValue(baseArgs, '--conversation').filter(
      (a) => a !== '--continue' && a !== '-c',
    )
    return sessionId ? ['--conversation', sessionId, ...clean] : ['--continue', ...clean]
  }
  // opencode: `--session <id>` quando conhecemos o ID, senão `--continue`
  // retoma a última sessão.
  const clean = stripFlagWithValue(baseArgs, '--session').filter(
    (a) => a !== '--resume' && a !== '--continue',
  )
  return sessionId ? ['--session', sessionId, ...clean] : ['--continue', ...clean]
}

type ResumeTarget = {
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  agent: AgentType
  cwd: string
  extraArgs: string[]
}

/** Coleta todos os painéis de agente atualmente vivos na workspace. */
function collectLivePanes(): ResumeTarget[] {
  const { projects } = useProjectsStore.getState()
  const { byPtyId } = useTerminalsStore.getState()
  const targets: ResumeTarget[] = []
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!RESUMABLE.includes(tab.type)) continue
        const ptyId = tab.ptyId
        if (!ptyId || !byPtyId[ptyId]?.alive) continue
        targets.push({
          projectId: project.id,
          terminalId: terminal.id,
          tabId: tab.id,
          ptyId,
          agent: tab.type,
          cwd: (tab.cwd || terminal.cwd || '').trim(),
          extraArgs: tab.extraArgs ?? [],
        })
      }
    }
  }
  return targets
}

/**
 * Quantos painéis de agente seriam reiniciados agora, em toda a workspace
 * (todos os projetos/grupos, não só o visível) — usado pra confirmar com o
 * usuário antes de disparar um `resetLastSession()` grande.
 */
export function countLiveResumablePanes(): number {
  return collectLivePanes().length
}

/**
 * Força o resume da última sessão em cada painel de agente aberto.
 * Retorna quantos foram retomados de quantos painéis vivos havia.
 *
 * Cada restart passa pela `spawnQueue` (mesma fila usada pra abrir terminais
 * normalmente) pra respeitar o teto de concorrência e a pausa de pressão de
 * memória do resource supervisor — sem isso, muitos painéis acumulados em
 * background reiniciariam em sequência sem nenhuma checagem de RAM.
 */
export async function resetLastSession(): Promise<ResetLastSessionResult> {
  const targets = collectLivePanes()
  let resumed = 0

  for (const target of targets) {
    const acquired = await acquireSpawnSlot()
    if (!acquired) continue
    try {
      let cwd = target.cwd
      if (!cwd) {
        const live = await getPtyCwd(target.ptyId).catch(() => null)
        cwd = (live ?? '').trim()
      }

      // Sessão atualmente aberta nesse pane (pra não resumir ela mesma).
      const active = getActiveSessions()[target.ptyId]
      const exclude: SessionExclude = {
        id:
          target.agent === 'codex'
            ? active?.codexSessionId
            : target.agent === 'opencode'
              ? active?.opencodeSessionId
              : active?.claudeSessionId,
        before: active?.timestamp,
      }
      const savedOpenCodeId = target.agent === 'opencode' ? active?.opencodeSessionId : undefined
      const sessionId = await latestSessionId(target.agent, cwd, exclude, savedOpenCodeId)
      const extraArgs = buildResumeArgs(target.agent, target.extraArgs, sessionId)

      // Ignora o exit event do PTY antigo (chega async após o restart).
      useTerminalsStore.getState().beginRestart(target.ptyId)
      await restartPty({
        id: target.ptyId,
        cols: 80,
        rows: 24,
        command: target.agent,
        cwd: cwd || undefined,
        extraArgs,
      })
      window.dispatchEvent(
        new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId: target.ptyId } }),
      )

      // Re-arma o resume automático pra que o próximo boot também retome.
      saveSession(target.ptyId, {
        sessionId: target.ptyId,
        claudeSessionId: target.agent === 'claude' ? (sessionId ?? undefined) : undefined,
        codexSessionId: target.agent === 'codex' ? (sessionId ?? undefined) : undefined,
        opencodeSessionId: target.agent === 'opencode' ? (sessionId ?? undefined) : undefined,
        cwd,
        agent: target.agent,
        timestamp: Date.now(),
      })
      if (sessionId) {
        useProjectsStore
          .getState()
          .setSubTabSessionId(target.projectId, target.terminalId, target.tabId, sessionId)
      }

      resumed++
    } catch {
      // Uma falha num painel não aborta o resto.
    } finally {
      releaseSpawnSlot()
    }
  }

  return { resumed, total: targets.length }
}
