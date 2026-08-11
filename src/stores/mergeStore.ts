import { create } from 'zustand'
import {
  mergeAnalyze,
  mergePrepare,
  mergeFinalize,
  mergeAbort,
  mergePreflightAbort,
  mergeRebaseOntoTarget,
  mergeForceCleanup,
  gitStatus,
  worktreeFetchBranch,
  worktreeCommitPending,
  worktreeRemove,
  killPtyTree,
  watchFile,
  unwatchFile,
  listenFileChanged,
  listenPtyExit,
  type MergeAnalysis,
  type ConflictEnv,
  type MergeOutcome,
} from '../lib/tauri'
import { useProjectsStore } from './projectsStore'
import { useUiStore } from './uiStore'
import { translate, getLocale } from '../lib/i18n'
import type { AgentType, Project } from '../lib/types'

/**
 * RFC-006/007/008 — orquestração do ciclo de merge seguro no front.
 *
 * `analyze → prepare → [conflito? spawna agente efêmero num terminal VISÍVEL do
 * projeto] → finalize (validação + ff) → teardown do terminal`.
 *
 * O agente efêmero é a única exceção autônoma do blueprint, mas continua
 * humano-visível: ele roda num Terminal normal do projeto (o usuário vê e pode
 * intervir). O provider vem de `project.conflictAgentProvider` (RFC-009).
 *
 * A finalização é auto-disparada por 3 camadas em cascata, nenhuma delas
 * confiável sozinha (ver `beginResolvingWatch`): marcador de arquivo
 * (`ALETHE_RESOLVED`), saída do processo do agente (`pty://exit`), e um poll
 * barato de fallback. Nenhuma camada decide corretude — quem decide é sempre
 * o `merge_finalize` do backend (varre marcadores + roda validação),
 * idêntico não importa o provider/qualidade do modelo.
 */
export type MergePhase =
  | 'idle'
  | 'analyzing'
  | 'preparing'
  | 'resolving'
  | 'finalizing_commit'
  | 'branch_diverged'
  | 'rebase_attempt'
  | 'merged'
  | 'failed'
  | 'terminal_error'

/** Fases em que já existe um merge em andamento — uma integração por vez
 *  (ver integrateWorktree). Exportado pra UI (SidebarMergePanel) desabilitar
 *  ações de outros cards enquanto uma integração está ocupada, sem duplicar
 *  a lista. */
export const MERGE_BUSY_PHASES: MergePhase[] = [
  'analyzing',
  'preparing',
  'resolving',
  'finalizing_commit',
  'branch_diverged',
  'rebase_attempt',
]

type MergeState = {
  phase: MergePhase
  projectId: string | null
  repo: string | null
  analysis: MergeAnalysis | null
  env: ConflictEnv | null
  outcome: MergeOutcome | null
  error: string | null
  /** Terminal efêmero criado para o agente de conflito (para teardown/reabertura). */
  agentTerminalId: string | null
  /** ID da worktree de origem, quando o merge nasceu de integrateWorktree — permite
   *  à UI (SidebarMergePanel) saber qual card corresponde ao merge ativo no momento. */
  worktreeAgentId: string | null
  /** Lock de reentrância: true durante qualquer chamada de finalize/retry/abort-bruto em progresso. */
  isFinalizing: boolean
  /** Tentativas de "Retry Manual" desde o último sucesso — zera em merged/idle. */
  retryCount: number
  /** Motivo do lock administrativo do git, quando é essa a causa da fase `failed`. */
  adminLockReason: string | null

  analyze: (project: Project, repo: string, source: string, target: string) => Promise<void>
  start: (
    project: Project,
    repo: string,
    source: string,
    target: string,
    worktreeAgentId?: string,
  ) => Promise<void>
  /** `silentRetry`: usado pelo poll de fallback — não reabre terminal nem mostra toast em falha (o agente pode só ainda estar trabalhando). */
  finalize: (opts?: { silentRetry?: boolean }) => Promise<void>
  /** Reexecuta o abort preventivo no ambiente efêmero e chama finalize do topo. Lock administrativo não incrementa retryCount nem vira TerminalError. */
  retry: () => Promise<void>
  abort: () => Promise<void>
  /**
   * RFC-003 Fase 3 — botão "Integrar" do pane em worktree: (localCopy) fetch do
   * branch do clone → ciclo de merge para o branch atual → sucesso destrói a
   * worktree e o pane. UMA integração por vez (merge.busy).
   */
  integrateWorktree: (
    project: Project,
    repo: string,
    worktreeAgentId: string,
    paneTerminalId: string,
  ) => Promise<void>
  reset: () => void
}

/** Prompt inicial do agente efêmero — escopo travado, aponta pro arquivo de contexto. */
function conflictPrompt(): string {
  return (
    'Leia o arquivo ALETHE_CONFLICT.md neste diretório e resolva SOMENTE os conflitos ' +
    'de merge listados nele, preservando a intenção das duas branches. Não implemente ' +
    'funcionalidades, não commite — apenas salve os arquivos resolvidos e avise quando terminar.'
  )
}

/** Prompt de retry — o agente novo não tem memória da tentativa anterior, então o motivo da falha precisa ir no prompt. */
function retryPrompt(failureContext: string): string {
  return (
    'A tentativa anterior de resolver este conflito falhou. Leia o arquivo ALETHE_CONFLICT.md ' +
    'neste diretório de novo e corrija o problema abaixo, preservando a intenção das duas ' +
    'branches. Não implemente funcionalidades, não commite — apenas salve os arquivos e avise ' +
    'quando terminar.\n\nMotivo da falha anterior:\n' +
    failureContext.slice(0, 2000)
  )
}

/** Args iniciais por provider para abrir o CLI já com a tarefa e o modelo correto. */
function providerArgs(provider: AgentType, prompt: string, model?: string): string[] {
  const modelFlags = model ? ['--model', model] : []
  switch (provider) {
    case 'codex':
      return [...modelFlags, prompt]
    case 'opencode':
      return [...modelFlags, prompt]
    case 'claude':
    default:
      return [...modelFlags, prompt]
  }
}

function toast(title: string, body: string) {
  useUiStore.getState().pushToast({ title, body })
}

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

function adminLockReasonFrom(message: string): string | null {
  const match = message.match(/admin_locked:(.*)$/s)
  return match ? match[1] : null
}

/** Fecha o terminal antigo (se houver) e abre um novo apontando pro mesmo cwd — não existe "resumir" um PTY morto, só recriar (ver decisão de design do plano). */
function reopenAgentTerminal(
  set: (partial: Partial<MergeState>) => void,
  get: () => MergeState,
  failureContext: string,
) {
  const { projectId, agentTerminalId, env } = get()
  if (!projectId || !env) return
  const store = useProjectsStore.getState()
  const project = store.projects.find((p) => p.id === projectId)
  if (!project) return
  if (agentTerminalId) {
    store.deleteTerminal(projectId, agentTerminalId)
  }
  const provider = project.conflictAgentProvider ?? 'claude'
  const model = project.conflictAgentModel
  const terminal = store.createTerminal(projectId, {
    name: `merge ${env.id.slice(0, 6)}`,
    cwd: env.path,
    firstTab: {
      type: provider,
      cwd: env.path,
      extraArgs: providerArgs(provider, retryPrompt(failureContext), model),
    },
  })
  set({ agentTerminalId: terminal.id })
  beginResolvingWatch(env, terminal.id)
}

// --- Gatilho automático de finalize (3 camadas em cascata) ---
//
// Nenhuma camada é a fonte de verdade de correção — isso continua sendo o
// merge_finalize determinístico do backend. Estas camadas só decidem QUANDO
// vale a pena checar de novo, sem depender do agente cooperar com nenhuma
// convenção do Alethe:
//   1. watchFile no marcador ALETHE_RESOLVED (mais rápido, se o agente criar).
//   2. pty://exit do terminal do agente (processo morreu sem criar marcador).
//   3. poll barato periódico (funciona mesmo sem nenhuma cooperação do agente
//      — o merge_finalize já faz sua própria checagem barata de marcadores
//      antes de rodar validação, então o poll só aciona o mesmo caminho real).

const POLL_INTERVAL_MS = 7000

let activeWatch: { stop: () => void } | null = null

function stopResolvingWatch() {
  activeWatch?.stop()
  activeWatch = null
}

function beginResolvingWatch(env: ConflictEnv, agentTerminalId: string) {
  stopResolvingWatch()
  const markerPath = `${env.path.replace(/[\\/]+$/, '')}/ALETHE_RESOLVED`
  let stopped = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let unlistenFile: (() => void) | null = null
  let unlistenExit: (() => void) | null = null

  const signal = () => {
    if (stopped) return
    void useMergeStore.getState().finalize()
  }

  void (async () => {
    try {
      await watchFile(markerPath)
      unlistenFile = await listenFileChanged((path) => {
        if (path === markerPath) signal()
      })
    } catch (err) {
      console.warn('[mergeStore] watchFile indisponível, seguindo só com pty-exit/poll:', err)
    }
    try {
      unlistenExit = await listenPtyExit(agentTerminalId, () => signal())
    } catch (err) {
      console.warn('[mergeStore] listenPtyExit falhou:', err)
    }
    pollTimer = setInterval(() => {
      void useMergeStore.getState().finalize({ silentRetry: true })
    }, POLL_INTERVAL_MS)

    // Corrida: se já saímos de resolving enquanto o setup assíncrono rodava,
    // desliga na hora em vez de deixar listeners/timer vazando.
    if (useMergeStore.getState().phase !== 'resolving' || stopped) {
      unlistenFile?.()
      unlistenExit?.()
      if (pollTimer) clearInterval(pollTimer)
      void unwatchFile(markerPath).catch(() => {})
    }
  })()

  activeWatch = {
    stop: () => {
      if (stopped) return
      stopped = true
      if (pollTimer) clearInterval(pollTimer)
      unlistenFile?.()
      unlistenExit?.()
      void unwatchFile(markerPath).catch(() => {})
    },
  }
}

export const useMergeStore = create<MergeState>((set, get) => ({
  phase: 'idle',
  projectId: null,
  repo: null,
  analysis: null,
  env: null,
  outcome: null,
  error: null,
  agentTerminalId: null,
  worktreeAgentId: null,
  isFinalizing: false,
  retryCount: 0,
  adminLockReason: null,

  analyze: async (project, repo, source, target) => {
    set({ phase: 'analyzing', projectId: project.id, repo, analysis: null, error: null })
    try {
      const analysis = await mergeAnalyze(repo, source, target, project.id)
      set({ phase: 'idle', analysis })
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
    }
  },

  start: async (project, repo, source, target, worktreeAgentId) => {
    stopResolvingWatch()
    set({
      phase: 'preparing',
      projectId: project.id,
      repo,
      env: null,
      outcome: null,
      error: null,
      agentTerminalId: null,
      worktreeAgentId: worktreeAgentId ?? null,
      isFinalizing: false,
      retryCount: 0,
      adminLockReason: null,
    })
    try {
      const env = await mergePrepare(repo, source, target, project.id)
      set({ env })
      if (env.clean) {
        // Sem conflito: valida e integra direto, sem agente.
        await get().finalize()
        return
      }
      // Conflito: spawna o agente efêmero num terminal visível do projeto.
      const provider = project.conflictAgentProvider ?? 'claude'
      const model = project.conflictAgentModel
      const terminal = useProjectsStore.getState().createTerminal(project.id, {
        name: `merge ${env.id.slice(0, 6)}`,
        cwd: env.path,
        firstTab: {
          type: provider,
          cwd: env.path,
          extraArgs: providerArgs(provider, conflictPrompt(), model),
        },
      })
      set({ phase: 'resolving', agentTerminalId: terminal.id })
      beginResolvingWatch(env, terminal.id)
      toast(t('merge.conflictTitle'), t('merge.conflictBody', { count: env.conflicts.length }))
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
    }
  },

  finalize: async (opts) => {
    const silentRetry = opts?.silentRetry ?? false
    const { repo, env, projectId, agentTerminalId, isFinalizing } = get()
    if (!repo || !env || isFinalizing) return

    if (!silentRetry) stopResolvingWatch()
    set({
      isFinalizing: true,
      outcome: null,
      error: null,
      phase: silentRetry ? get().phase : 'finalizing_commit',
    })

    try {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const commands = project?.validationCommands ?? []
      const outcome = await mergeFinalize(repo, env.id, commands)

      if (outcome.merged) {
        stopResolvingWatch()
        const mergedProject = projectId
          ? useProjectsStore.getState().projects.find((p) => p.id === projectId)
          : undefined
        const postAction = mergedProject?.mergePostAction ?? 'closeTerminal'
        let relocated = false

        if (projectId && agentTerminalId && postAction !== 'closeTerminal') {
          const result = await useProjectsStore
            .getState()
            .relocateMergeAgentTerminal(projectId, agentTerminalId, {
              keepSession: postAction === 'relocateKeepSession',
            })
          relocated = result.ok
          if (!result.ok) {
            console.warn(
              '[mergeStore] relocação pós-merge falhou, encerrando terminal:',
              result.error,
            )
          }
        }

        if (!relocated && projectId && agentTerminalId) {
          useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
        }
        set({
          phase: 'merged',
          outcome,
          env: null,
          agentTerminalId: relocated ? agentTerminalId : null,
          isFinalizing: false,
          retryCount: 0,
          adminLockReason: null,
        })
        toast(t('merge.mergedTitle'), outcome.output)
        // Camada 3 do Escudo (aviso, nunca bloqueou o merge acima) — informa
        // depois de integrado, pra revisão posterior do usuário.
        if (outcome.contractWarnings.length > 0) {
          toast(
            t('merge.contractWarningsTitle', { count: outcome.contractWarnings.length }),
            outcome.contractWarnings
              .map((w) => `${w.call.pathPattern} (${w.call.file}:${w.call.line})`)
              .join('\n'),
          )
        }
        return
      }

      if (outcome.stage === 'branch_diverged') {
        stopResolvingWatch()
        set({ phase: 'rebase_attempt', outcome, isFinalizing: true })
        try {
          const rebased = await mergeRebaseOntoTarget(repo, env.id)
          if (rebased.stage === 'rebase_ok') {
            set({ isFinalizing: false })
            await get().finalize()
            return
          }
          if (rebased.stage === 'rebase_conflict') {
            set({ phase: 'resolving', outcome: rebased, isFinalizing: false })
            reopenAgentTerminal(set, get, rebased.output)
            toast(t('merge.conflictTitle'), rebased.output.slice(0, 300))
            return
          }
          // rebase_failed — erro de execução do git/disco cheio etc.
          set({ phase: 'failed', outcome: rebased, error: rebased.output, isFinalizing: false })
          toast(t('merge.blockedTitle', { stage: rebased.stage }), rebased.output.slice(0, 300))
        } catch (err) {
          set({ phase: 'failed', error: String(err), isFinalizing: false })
        }
        return
      }

      const verificationFailedStages = new Set(['conflict_markers', 'unmerged'])
      if (verificationFailedStages.has(outcome.stage) || outcome.stage.startsWith('validation:')) {
        if (silentRetry) {
          // Agente ainda trabalhando — não é uma falha real, só o poll
          // batendo cedo. Não reabre terminal, não mostra toast.
          set({ isFinalizing: false })
          return
        }
        set({ phase: 'resolving', outcome, isFinalizing: false })
        reopenAgentTerminal(set, get, outcome.output)
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
        return
      }

      // target_not_checked_out, integration (não-divergência) e qualquer
      // outro stage não mapeado: erro duro recuperável via Retry Manual.
      // Estanca o watch de fallback: sem isso, no caminho silentRetry o poll de
      // 7s segue re-disparando finalize indefinidamente sobre o estado failed.
      stopResolvingWatch()
      set({ phase: 'failed', outcome, isFinalizing: false })
      if (!silentRetry)
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
    } catch (err) {
      const message = String(err)
      const adminLockReason = adminLockReasonFrom(message)
      // Idem: estanca o poll de fallback ao cair em failed no caminho silencioso.
      stopResolvingWatch()
      set({
        phase: 'failed',
        error: message,
        isFinalizing: false,
        adminLockReason,
      })
      if (!silentRetry) toast(t('merge.blockedTitle', { stage: 'finalize' }), message.slice(0, 300))
    }
  },

  retry: async () => {
    const { repo, env, isFinalizing, phase } = get()
    if (!repo || !env || isFinalizing || phase !== 'failed') return
    set({ isFinalizing: true, error: null })
    try {
      await mergePreflightAbort(repo, env.id)
    } catch (err) {
      const message = String(err)
      const adminLockReason = adminLockReasonFrom(message)
      if (adminLockReason) {
        // Lock administrativo detectado no abort preventivo — volta pra
        // Failed com o motivo, NÃO incrementa retryCount, NÃO vira TerminalError.
        set({ phase: 'failed', isFinalizing: false, error: message, adminLockReason })
      } else {
        // Erro genérico no abort preventivo = corrupção real do ambiente.
        set({ phase: 'terminal_error', isFinalizing: false, error: message })
      }
      return
    }
    set({ retryCount: get().retryCount + 1, adminLockReason: null, isFinalizing: false })
    await get().finalize()
  },

  integrateWorktree: async (project, repo, worktreeAgentId, paneTerminalId) => {
    if (MERGE_BUSY_PHASES.includes(get().phase)) {
      toast(t('merge.busyTitle'), t('merge.busy'))
      return
    }
    try {
      // git merge só move commits — se o agente escreveu arquivo e nunca
      // commitou, a branch dele não tem nada de novo em relação ao alvo e a
      // integração inteira vira um no-op silencioso (reporta "concluído" sem
      // mover nada — bug real, confirmado ao vivo). Commita automaticamente
      // o que estiver pendente antes de seguir; no-op numa worktree já limpa.
      await worktreeCommitPending(repo, worktreeAgentId)
      // LocalCopy: o branch vive no clone — traz pro repo principal primeiro.
      // (No modo gitWorktree é no-op no backend.)
      await worktreeFetchBranch(repo, worktreeAgentId)
      const target = (await gitStatus(repo)).branch
      const source = `alethe/agent-${worktreeAgentId}`
      await get().start(project, repo, source, target, worktreeAgentId)
      const { phase } = get()
      if (phase === 'merged') {
        // Integrado limpo: mata o processo do agente ANTES de tentar remover
        // a worktree — mesma causa-raiz do bug de "Rejeitar" já corrigido
        // (no Windows, apagar uma pasta que ainda é o cwd de um processo vivo
        // falha). Aguarda de verdade a árvore de processos morrer.
        const terminal = useProjectsStore
          .getState()
          .projects.find((p) => p.id === project.id)
          ?.terminals.find((term) => term.id === paneTerminalId)
        const ptyIds = (terminal?.tabs ?? [])
          .map((tab) => tab.ptyId)
          .filter((id): id is string => Boolean(id))
        await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))

        try {
          await worktreeRemove(repo, worktreeAgentId, true)
        } catch (err) {
          // "worktree_not_found" = já tinha sido removida, inofensivo. Falha
          // real nunca pode sumir só num console.warn — vira órfã rastreada
          // (mesma rede de segurança do abort()/Rejeitar), senão a pasta
          // fica presa em disco pra sempre, sem nenhum rastro na interface.
          if (!String(err).includes('worktree_not_found')) {
            useProjectsStore.getState().addOrphanWorktree(project.id, {
              path: terminal?.cwd ?? '',
              mode: 'gitWorktree',
            })
          }
          console.warn('[mergeStore] worktree já removida?', err)
        }
        useProjectsStore.getState().deleteTerminal(project.id, paneTerminalId)
      }
      // Em conflito, o fluxo normal segue (agente efêmero + Finalizar); a
      // worktree/pane originais ficam intactos até o merge concluir.
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
      toast(t('merge.blockedTitle', { stage: 'integrate' }), String(err).slice(0, 300))
    }
  },

  abort: async () => {
    const { repo, env, projectId, agentTerminalId, phase, isFinalizing } = get()
    if (isFinalizing) return // já tem uma limpeza/finalize em andamento — ignora duplo clique

    if (phase === 'terminal_error') {
      set({ isFinalizing: true })
      stopResolvingWatch()
      if (repo && env && projectId) {
        try {
          const result = await mergeForceCleanup(repo, env.id)
          if (result.deleted && !result.pruned) {
            useProjectsStore.getState().addOrphanWorktree(projectId, {
              path: env.path,
              mode: 'gitWorktree',
              pruneOnly: true,
              cleanAttempts: 0,
            })
          } else if (!result.deleted) {
            useProjectsStore.getState().addOrphanWorktree(projectId, {
              path: env.path,
              mode: 'gitWorktree',
              requiresRawDeletion: true,
            })
          }
          // deleted && pruned: totalmente limpo, nada a rastrear.
        } catch (err) {
          console.error('[mergeStore] limpeza bruta falhou:', err)
          useProjectsStore.getState().addOrphanWorktree(projectId, {
            path: env.path,
            mode: 'gitWorktree',
            requiresRawDeletion: true,
          })
        }
      }
      if (projectId && agentTerminalId) {
        useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
      }
      set({
        phase: 'idle',
        env: null,
        outcome: null,
        agentTerminalId: null,
        worktreeAgentId: null,
        error: null,
        isFinalizing: false,
        retryCount: 0,
        adminLockReason: null,
      })
      return
    }

    stopResolvingWatch()
    if (repo && env) {
      try {
        await mergeAbort(repo, env.id)
      } catch (err) {
        console.error('[mergeStore] Falha ao abortar merge:', err)
      }
    }
    if (projectId && agentTerminalId) {
      useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
    }
    set({
      phase: 'idle',
      env: null,
      outcome: null,
      agentTerminalId: null,
      worktreeAgentId: null,
      error: null,
      retryCount: 0,
      adminLockReason: null,
    })
  },

  reset: () => {
    stopResolvingWatch()
    set({
      phase: 'idle',
      analysis: null,
      env: null,
      outcome: null,
      error: null,
      agentTerminalId: null,
      worktreeAgentId: null,
      isFinalizing: false,
      retryCount: 0,
      adminLockReason: null,
    })
  },
}))
