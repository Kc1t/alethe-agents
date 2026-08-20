import { create } from 'zustand'

import { getLocale, type Locale, translate } from '../lib/i18n'
import {
  type ConflictEnv,
  gitStatus,
  killPtyTree,
  listenFileChanged,
  listenPtyExit,
  mergeAbort,
  type MergeAnalysis,
  mergeAnalyze,
  mergeFinalize,
  mergeForceCleanup,
  type MergeOutcome,
  mergePreflightAbort,
  mergePrepare,
  mergeRebaseOntoTarget,
  mergeValidate,
  readTextFile,
  unwatchFile,
  watchFile,
  worktreeCommitPending,
  worktreeFetchBranch,
  worktreeRemove,
} from '../lib/tauri'
import type { Project } from '../lib/types'
import { useProjectsStore } from './projectsStore'
import { useUiStore } from './uiStore'

/**
 * RFC-006/007/008 — orquestração do ciclo de merge seguro no front.
 *
 * `analyze → prepare → [conflito? spawna agente efêmero num terminal VISÍVEL do
 * projeto] → agente sinaliza "terminei" (awaiting_review) → clique manual em
 * "Validar" → clique manual em "Integrar" (commit + ff) → teardown do terminal`.
 *
 * O agente efêmero é a única exceção autônoma do blueprint, mas continua
 * humano-visível: ele roda num Terminal normal do projeto (o usuário vê e pode
 * intervir). O provider vem de `project.conflictAgentProvider` (RFC-009).
 *
 * A detecção de "terminei" é disparada por 3 camadas em cascata, nenhuma
 * delas confiável sozinha (ver `beginResolvingWatch`): marcador de arquivo
 * (`ALETHE_RESOLVED`), saída do processo do agente (`pty://exit`), e um poll
 * barato de fallback (só relê o marcador, nunca chama o backend). Nenhuma
 * camada valida, commita ou integra nada sozinha — elas só páram em
 * `awaiting_review` e esperam confirmação humana. Pedido explícito do
 * usuário: o gatilho antigo chamava `merge_finalize` (valida+commita+integra
 * tudo junto) sozinho assim que qualquer camada disparava, sem nenhum humano
 * confirmar se a resolução do agente fazia sentido — confirmado ao vivo como
 * imprudente. Quem decide corretude continua sendo sempre o backend
 * (`merge_validate`/`merge_finalize`, que varrem marcadores + rodam
 * validação), idêntico não importa o provider/qualidade do modelo — só que
 * agora só rodam quando o usuário clica.
 */
export type MergePhase =
  | 'idle'
  | 'analyzing'
  | 'preparing'
  | 'resolving'
  /** Agente sinalizou "terminei" (marcador ALETHE_RESOLVED, pty saiu, ou o
   *  poll de fallback achou o marcador) — mas NADA foi checado/validado/
   *  commitado ainda. Pedido explícito do usuário: o gatilho automático de
   *  3 camadas integrava sozinho sem nenhum humano confirmar se a resolução
   *  fazia sentido (confirmado ao vivo como imprudente). A partir daqui só
   *  clique manual em "Validar" e depois "Integrar" avança o merge. */
  | 'awaiting_review'
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
  'awaiting_review',
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
  /** Só roda a Validation Pipeline (marcadores + testes/build) — não commita nem integra. Gate manual antes de `finalize`. */
  validate: () => Promise<void>
  /** Commita e integra de verdade — sempre disparado por clique manual (Integrar), nunca automaticamente. */
  finalize: () => Promise<void>
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

/** Regras/passo a passo compartilhados pelos dois prompts (inicial e retry) —
 *  agente-facing, por isso fora do i18n de UI (mensagens próprias, não vêm de
 *  `messages/*.ts`), mas seguem o IDIOMA ATUAL do app (`getLocale()`) — pedido
 *  explícito do usuário: o Alethe já tem duas línguas (en/pt-BR), então o
 *  agente de conflito devia falar a mesma língua que o usuário está usando no
 *  app, com instrução explícita nesse sentido (a língua da UI não garante que
 *  o modelo vá responder nela sozinho). Reescrito pra ser um resolvedor de
 *  verdade, não só "leia e resolva": lê CADA arquivo inteiro (não só os
 *  marcadores) pra entender intenção real de cada lado, e — pedido explícito
 *  do usuário — pergunta ANTES de decidir sozinho quando a escolha entre os
 *  dois lados for realmente ambígua, em vez de sempre resolver tudo
 *  automaticamente. Também instrui a criar o marcador `ALETHE_RESOLVED` ao
 *  terminar: sem isso, a detecção de conclusão nunca usava a camada mais
 *  rápida (watchFile), só o poll de 7s ou o processo morrer — o agente nunca
 *  sabia que devia criar esse arquivo. */
function conflictRules(locale: Locale): string {
  if (locale === 'en') {
    return (
      '## HIGH PRIORITY — never skip, no matter what\n' +
      '- Respond in English. This instruction is in English because the app is currently set to English.\n' +
      '- NEVER implement features or fix bugs unrelated to the listed conflicts. Scope is only what is in ALETHE_CONFLICT.md.\n' +
      '- NEVER commit.\n' +
      '- NEVER decide a genuinely ambiguous conflict alone (both sides changed the same thing in incompatible ways, with no obvious way to combine them) — STOP and ask the user here in the terminal how they want to proceed, explaining the conflict and the options.\n' +
      '- ALWAYS resolve ALL listed files, none left out.\n\n' +
      '## MEDIUM PRIORITY — how to resolve each file (resolution quality)\n' +
      '1. Read the WHOLE file (not just the conflict markers) to understand the real context on each side.\n' +
      '2. Understand the INTENT of each branch — what each one was actually trying to achieve, not just the literal text.\n' +
      '3. If the two changes are compatible, combine them preserving both intents (not ambiguous — resolve directly, no need to ask).\n' +
      '4. After resolving, confirm no conflict markers (<<<<<<<, =======, >>>>>>>) remain in the file.\n\n' +
      '## WHEN DONE — high priority\n' +
      '- Create an empty file named ALETHE_RESOLVED in this directory (this is the signal Alethe uses to know you finished).\n' +
      '- Announce that you are done.'
    )
  }
  return (
    '## PRIORIDADE ALTA — nunca ignore, não importa o quê\n' +
    '- Responda em português (pt-BR). Esta instrução está em português porque o app está com o idioma em português no momento.\n' +
    '- NUNCA implemente funcionalidades ou corrija bugs não relacionados aos conflitos listados. Escopo é só o que está em ALETHE_CONFLICT.md.\n' +
    '- NUNCA commite.\n' +
    '- NUNCA decida sozinho um conflito realmente ambíguo (os dois lados mudaram a mesma coisa de forma incompatível, sem um jeito óbvio de combinar) — PARE e pergunte ao usuário aqui no terminal como ele quer prosseguir, explicando o conflito e as opções.\n' +
    '- SEMPRE resolva TODOS os arquivos listados, nenhum a menos.\n\n' +
    '## PRIORIDADE MÉDIA — como resolver cada arquivo (qualidade da resolução)\n' +
    '1. Leia o arquivo INTEIRO (não só os marcadores de conflito) pra entender o contexto real de cada lado.\n' +
    '2. Entenda a INTENÇÃO de cada branch — o que cada uma estava tentando alcançar, não só o texto literal.\n' +
    '3. Se as duas mudanças forem compatíveis, combine preservando a intenção das duas (não é ambíguo — resolva direto, sem perguntar).\n' +
    '4. Depois de resolver, confirme que não sobrou nenhum marcador de conflito (<<<<<<<, =======, >>>>>>>) no arquivo.\n\n' +
    '## AO TERMINAR — prioridade alta\n' +
    '- Crie um arquivo vazio chamado ALETHE_RESOLVED neste diretório (é o sinal que o Alethe usa pra saber que você acabou).\n' +
    '- Avise que terminou.'
  )
}

/** Prompt inicial do agente efêmero — escopo travado, aponta pro arquivo de contexto. */
function conflictPrompt(locale: Locale): string {
  if (locale === 'en') {
    return (
      'Read the ALETHE_CONFLICT.md file in this directory — it lists every file in conflict.\n\n' +
      conflictRules(locale)
    )
  }
  return (
    'Leia o arquivo ALETHE_CONFLICT.md neste diretório — ele lista todos os arquivos em conflito.\n\n' +
    conflictRules(locale)
  )
}

/** Prompt de retry — o agente novo não tem memória da tentativa anterior, então o motivo da falha precisa ir no prompt. */
function retryPrompt(failureContext: string, locale: Locale): string {
  if (locale === 'en') {
    return (
      'The previous attempt to resolve this conflict failed. Read the ALETHE_CONFLICT.md file ' +
      'in this directory again and fix the issue below.\n\n' +
      conflictRules(locale) +
      '\n\nReason the previous attempt failed:\n' +
      failureContext.slice(0, 2000)
    )
  }
  return (
    'A tentativa anterior de resolver este conflito falhou. Leia o arquivo ALETHE_CONFLICT.md ' +
    'neste diretório de novo e corrija o problema abaixo.\n\n' +
    conflictRules(locale) +
    '\n\nMotivo da falha anterior:\n' +
    failureContext.slice(0, 2000)
  )
}

/** Flags iniciais pra abrir o CLI já com o modelo correto — nunca o prompt
 *  aqui (vai via `initialInput`, digitado no terminal depois do boot). O
 *  OpenCode trata um argumento posicional solto como PASTA a abrir, não como
 *  prompt inicial — passar o texto do conflito por `extraArgs` fazia ele
 *  tentar `cd` pro próprio texto do prompt concatenado ao cwd real
 *  (`Failed to change directory to <cwd>\<prompt inteiro>`, confirmado ao
 *  vivo). `initialInput` é o mesmo mecanismo já usado pelo prompt rápido da
 *  Home pra qualquer provider, incluindo OpenCode — funciona pros quatro. */
function providerArgs(model?: string): string[] {
  return model ? ['--model', model] : []
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
      extraArgs: providerArgs(model),
      initialInput: retryPrompt(failureContext, getLocale()),
    },
    ephemeralConflictAgent: true,
  })
  set({ agentTerminalId: terminal.id })
  beginResolvingWatch(env, terminal.id)
}

// --- Gatilho automático de "aguardando revisão" (3 camadas em cascata) ---
//
// NENHUMA camada valida, commita ou integra nada sozinha — elas só detectam
// que o agente sinalizou "terminei" e páram, esperando confirmação manual
// (botões Validar/Integrar na UI, fase `awaiting_review`). Pedido explícito
// do usuário: o gatilho antigo chamava merge_finalize (valida+commita+
// integra tudo junto) sozinho assim que qualquer camada disparava, sem
// nenhum humano confirmar se a resolução do agente fazia sentido —
// confirmado ao vivo como imprudente (agente juntou conteúdo incompatível
// num arquivo só, sem perguntar, e foi commitado/integrado automaticamente).
//   1. watchFile no marcador ALETHE_RESOLVED (mais rápido, se o agente criar).
//   2. pty://exit do terminal do agente (processo morreu — terminou ou
//      crashou; "Validar" mostra qual dos dois foi, não decidimos aqui).
//   3. poll barato periódico (fallback caso o watchFile do SO perca o evento
//      de criação do marcador — só relê o arquivo, nunca chama o backend).

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
    activeWatch?.stop()
    if (useMergeStore.getState().phase === 'resolving') {
      useMergeStore.setState({ phase: 'awaiting_review' })
    }
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
      readTextFile(markerPath)
        .then(() => signal())
        .catch(() => {
          /* marcador ainda não existe — nada a fazer, só o próximo tick */
        })
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
          extraArgs: providerArgs(model),
          initialInput: conflictPrompt(getLocale()),
        },
        ephemeralConflictAgent: true,
      })
      set({ phase: 'resolving', agentTerminalId: terminal.id })
      beginResolvingWatch(env, terminal.id)
      toast(t('merge.conflictTitle'), t('merge.conflictBody', { count: env.conflicts.length }))
    } catch (err) {
      set({ phase: 'failed', error: String(err) })
    }
  },

  validate: async () => {
    const { repo, env, projectId, isFinalizing } = get()
    if (!repo || !env || isFinalizing) return
    set({ isFinalizing: true, outcome: null, error: null })
    try {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const commands = project?.validationCommands ?? []
      const outcome = await mergeValidate(repo, env.id, commands)
      set({ outcome, isFinalizing: false })
      if (outcome.stage === 'validated') {
        if (outcome.validationRan) {
          toast(t('merge.validationPassedTitle'), t('merge.validationPassedBody'))
        } else {
          toast(t('merge.validationUnverifiedTitle'), t('merge.validationUnverifiedBody'))
        }
      } else {
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
      }
    } catch (err) {
      set({ isFinalizing: false })
      toast(t('merge.blockedTitle', { stage: 'validate' }), String(err).slice(0, 300))
    }
  },

  finalize: async () => {
    const { repo, env, projectId, agentTerminalId, isFinalizing } = get()
    if (!repo || !env || isFinalizing) return

    stopResolvingWatch()
    set({ isFinalizing: true, outcome: null, error: null, phase: 'finalizing_commit' })

    // Mata o processo do agente ANTES de chamar o backend: se o merge for
    // bem-sucedido, `merge_finalize` (Rust) faz `git worktree remove --force`
    // na hora, na MESMA chamada — sem isso, a pasta que ainda é o cwd do
    // processo do agente é apagada com ele potencialmente vivo ali dentro
    // (mesma causa-raiz já corrigida em Rejeitar/integrateWorktree: no
    // Windows, apagar pasta com processo vivo como cwd falha/corrompe
    // estado — confirmado ao vivo: terminal "reiniciado sem sessão" depois
    // do merge). `killPtyTree` espera de verdade a árvore morrer, diferente
    // do `killPty` fire-and-forget que `deleteTerminal` dispara sozinho.
    if (projectId && agentTerminalId) {
      const terminal = useProjectsStore
        .getState()
        .projects.find((p) => p.id === projectId)
        ?.terminals.find((term) => term.id === agentTerminalId)
      const ptyIds = (terminal?.tabs ?? [])
        .map((tab) => tab.ptyId)
        .filter((id): id is string => Boolean(id))
      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))
    }

    try {
      const project = useProjectsStore.getState().projects.find((p) => p.id === projectId)
      const commands = project?.validationCommands ?? []
      const outcome = await mergeFinalize(
        repo,
        env.id,
        commands,
        project?.healthCheckCommand,
        project?.healthCheckPath,
      )

      if (outcome.merged) {
        stopResolvingWatch()
        // O agente efêmero é DESCARTÁVEL por design ("nasce, resolve,
        // morre") — nunca reloca pra branch nova nem tenta manter sessão
        // (isso é `mergePostAction`, uma opção do agente de trabalho REAL
        // aplicada em `integrateWorktree`/`paneTerminalId`, não aqui).
        // Aplicar relocate neste terminal descartável já causou um card
        // fantasma na Central de Merges (ganhava um worktreeAgentId de
        // verdade sem ser um worktree de agente de verdade).
        if (projectId && agentTerminalId) {
          useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
        }
        set({
          phase: 'merged',
          outcome,
          env: null,
          agentTerminalId: null,
          isFinalizing: false,
          retryCount: 0,
          adminLockReason: null,
        })
        toast(t('merge.mergedTitle'), outcome.output)
        // Honestidade pós-merge: o auto-merge de branches limpas continua
        // automático (decisão deliberada), mas não pode fingir que checou
        // algo que não checou — avisa quando integrou sem nenhum comando de
        // validação configurado.
        if (!outcome.validationRan) {
          toast(t('merge.mergedUnverifiedTitle'), t('merge.mergedUnverifiedBody'))
        }
        // Camada 4 do Escudo (aviso, nunca bloqueou o merge acima) — só
        // presente se o projeto tinha `healthCheckCommand` configurado.
        if (outcome.healthProbe) {
          const hp = outcome.healthProbe
          toast(
            hp.responded ? t('merge.healthProbePassedTitle') : t('merge.healthProbeFailedTitle'),
            hp.responded
              ? t('merge.healthProbePassedBody', {
                  ms: hp.elapsedMs,
                  status: String(hp.statusCode ?? '—'),
                })
              : t('merge.healthProbeFailedBody', {
                  ms: hp.elapsedMs,
                  output: hp.outputTail.slice(0, 240),
                }),
          )
        }
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

      if (outcome.stage === 'nothing_to_integrate') {
        // Honesto em vez de fingir sucesso (bug real corrigido no backend,
        // ver `conflict_resolution.rs`): a branch não tinha nenhuma mudança
        // em relação ao alvo — nada foi commitado, `main` não avança. Não é
        // um erro pra tentar de novo (não tem "retry" que resolva "nada pra
        // fazer"), então não vira `phase: 'failed'` — só informa e limpa o
        // agente efêmero de conflito (se for esse o caso). O worktree/
        // terminal do agente REAL (fluxo `integrateWorktree`) fica intacto —
        // `phase` não vira `'merged'`, então a limpeza de lá nem roda,
        // deixando o usuário decidir (o card continua visível pra ele
        // rejeitar/investigar).
        stopResolvingWatch()
        if (projectId && agentTerminalId) {
          useProjectsStore.getState().deleteTerminal(projectId, agentTerminalId)
        }
        set({
          phase: 'idle',
          outcome,
          env: null,
          agentTerminalId: null,
          isFinalizing: false,
          retryCount: 0,
          adminLockReason: null,
        })
        toast(t('merge.nothingToIntegrateTitle'), t('merge.nothingToIntegrateBody'))
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
        set({ phase: 'resolving', outcome, isFinalizing: false })
        reopenAgentTerminal(set, get, outcome.output)
        toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
        return
      }

      // target_not_checked_out, integration (não-divergência) e qualquer
      // outro stage não mapeado: erro duro recuperável via Retry Manual.
      stopResolvingWatch()
      set({ phase: 'failed', outcome, isFinalizing: false })
      toast(t('merge.blockedTitle', { stage: outcome.stage }), outcome.output.slice(0, 300))
    } catch (err) {
      const message = String(err)
      const adminLockReason = adminLockReasonFrom(message)
      stopResolvingWatch()
      set({
        phase: 'failed',
        error: message,
        isFinalizing: false,
        adminLockReason,
      })
      toast(t('merge.blockedTitle', { stage: 'finalize' }), message.slice(0, 300))
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
        const projectAtCleanup = useProjectsStore
          .getState()
          .projects.find((p) => p.id === project.id)
        const terminal = projectAtCleanup?.terminals.find((term) => term.id === paneTerminalId)
        // O terminal "viewer" da sessão-filha GSD Sync (se existir) é uma
        // entidade SEPARADA, casada só por `cwd` — matar só o pane principal
        // aqui e deixar `deleteTerminal` (mais abaixo) matar o viewer por
        // último não basta: `worktreeRemove`, logo em seguida, já apaga a
        // pasta do disco enquanto o processo do viewer ainda pode estar vivo
        // nela (confirmado ao vivo: "ENOENT: no such file or directory,
        // lstat <worktree>" num terminal GSD Sync órfão). Mata os dois juntos
        // agora, antes de qualquer remoção de disco.
        const gsdViewer = projectAtCleanup?.terminals.find(
          (term) => term.gsdSyncViewer && term.cwd === terminal?.cwd,
        )
        const ptyIds = [...(terminal?.tabs ?? []), ...(gsdViewer?.tabs ?? [])]
          .map((tab) => tab.ptyId)
          .filter((id): id is string => Boolean(id))
        await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))

        try {
          await worktreeRemove(repo, worktreeAgentId, true)
        } catch (err) {
          // "worktree_not_found" = já tinha sido removida, inofensivo. Falha
          // real nunca pode sumir só num console.warn — vira órfã rastreada
          // (mesma rede de segurança do abort()/Rejeitar), senão a pasta
          // fica presa em disco pra sempre, sem nenhum rastro na interface —
          // e o toast "Merge concluído" já mostrado fica parecendo mentira
          // pro usuário (bug real, confirmado ao vivo: worktree sobrevivia
          // e nada avisava). Agora avisa também.
          if (!String(err).includes('worktree_not_found')) {
            useProjectsStore.getState().addOrphanWorktree(project.id, {
              path: terminal?.cwd ?? '',
              mode: 'gitWorktree',
            })
            toast(t('merge.worktreeRemoveFailedTitle'), String(err).slice(0, 300))
          }
          console.warn('[mergeStore] worktree já removida?', err)
        }

        // Ação pós-merge do agente (config do projeto) — bug real corrigido:
        // `relocateMergeAgentTerminal` já existia pronta e testada, mas
        // nunca era chamada; o terminal sempre era fechado incondicionalmente
        // aqui, ignorando "Criar nova branch e manter chat ativo"/"...manter
        // sessão" configurados pelo usuário.
        const postAction = project.mergePostAction ?? 'closeTerminal'
        if (postAction === 'closeTerminal') {
          useProjectsStore.getState().deleteTerminal(project.id, paneTerminalId)
        } else {
          const relocated = await useProjectsStore
            .getState()
            .relocateMergeAgentTerminal(project.id, paneTerminalId, {
              keepSession: postAction === 'relocateKeepSession',
            })
          if (!relocated.ok) {
            // Não deixa o terminal preso apontando pra uma pasta que acabou
            // de ser removida — cai pro fechamento como último recurso.
            toast(t('merge.relocateFailedTitle'), relocated.error ?? '')
            useProjectsStore.getState().deleteTerminal(project.id, paneTerminalId)
          }
        }
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
    if (isFinalizing) {
      // Validar/Integrar (clique manual) já está em progresso — se o clique
      // em "Abortar" cair bem no meio dessa chamada, a guarda de
      // reentrância ignorava o clique sem nenhum aviso, parecendo que o
      // botão simplesmente não fazia nada (confirmado ao vivo: funcionava
      // só no segundo clique, sem explicação nenhuma).
      toast(t('merge.abortBusyTitle'), t('merge.abortBusy'))
      return
    }

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
