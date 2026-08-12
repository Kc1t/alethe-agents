import { Check, GitMerge, MessageSquare, Play, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useGsdSyncSessionsWatcher } from '../../hooks/useGsdSyncSessions'
import { useT } from '../../lib/i18n'
import {
  type DiffSummaryEntry,
  gitDiffSummary,
  gitStatus,
  type GsdProcedureStep,
  killPtyTree,
  readGsdProcedure,
  readTextFile,
  runValidation,
  type ValidationResult,
  worktreeCommitWorktree,
  type WorktreePendingChange,
  worktreePendingChanges,
  worktreeRemove,
  writePty,
} from '../../lib/tauri'
import { MERGE_BUSY_PHASES, type MergePhase, useMergeStore } from '../../stores/mergeStore'
import { getProjectRepoRoot, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { BranchTestingModal, type TestingItem } from '../modals/BranchTestingModal'
import { ConfirmWorktreeCommitModal } from '../modals/ConfirmWorktreeCommitModal'
import styles from './SidebarMergePanel.module.css'

/** Prompt inicial do Revisor de Branch — agente-facing (aparece no terminal
 *  dele, não na UI do Alethe), por isso fica fora do i18n, igual ao
 *  conflictPrompt() do mergeStore. Não implementa/corrige nada sozinho — só
 *  avalia e responde ao usuário no próprio terminal. */
function reviewPrompt(branch: string, target: string): string {
  return (
    `Revise as alterações da branch "${branch}" antes de um merge para "${target}". ` +
    `Rode \`git diff ${target}...HEAD\` neste diretório pra ver o diff completo. ` +
    'Aponte problemas reais (bugs, quebra de contrato, falta de tratamento de erro, ' +
    'inconsistência com o resto do código) — não implemente nada, não corrija nada sozinho, ' +
    'só avalie e explique. O usuário pode te responder aqui no terminal com pedidos de ajuste; ' +
    'quando achar que está tudo certo, diga isso explicitamente.'
  )
}

type PendingMergeCard = {
  id: string
  projectId: string
  projectName: string
  terminalId: string
  worktreeAgentId: string
  branchName: string
  worktreePath: string
  agentName: string
  gsdWatcherEnabled: boolean
  /** false quando o provider desta worktree não é OpenCode — o plugin GSD
   *  (que escreve `.planning/status.md`) só é instalado em terminais
   *  OpenCode, então a Camada 1 do gate nunca teria como passar aqui. */
  gsdGateApplicable: boolean
}

/** Fases do Gate de Conclusão de Planejamento GSD (opt-in via
 *  `gsdWatcherEnabled`) — `hidden`/`checking` nunca aparecem na lista, só
 *  `ready`/`failed`. `failed` significa "planejamento diz completo, mas a
 *  checagem automática (diff real ou validação) não confirmou" — mostrado,
 *  nunca escondido, porque esconder um problema real é pior que mostrá-lo. */
type GateStage = 'hidden' | 'checking' | 'ready' | 'failed'
type GateResult = { stage: GateStage; detail?: string }

/** Deriva o rótulo/tom do card a partir da fase real do mergeStore — só o
 *  card cujo worktreeAgentId bate com o merge ativo mostra progresso; os
 *  demais ficam neutros ("pronto para revisão"), sem prometer validação
 *  nenhuma que ainda não rodou. */
function statusInfo(phase: MergePhase, isActive: boolean) {
  if (!isActive) return { key: 'merge.statusReady' as const, tone: 'stopped' as const }
  switch (phase) {
    case 'analyzing':
    case 'preparing':
      return { key: 'merge.statusPreparing' as const, tone: 'waiting' as const }
    case 'resolving':
      return { key: 'merge.statusResolving' as const, tone: 'waiting' as const }
    case 'awaiting_review':
      return { key: 'merge.statusAwaitingReview' as const, tone: 'waiting' as const }
    case 'finalizing_commit':
      return { key: 'merge.statusFinalizing' as const, tone: 'waiting' as const }
    case 'branch_diverged':
    case 'rebase_attempt':
      return { key: 'merge.statusRebasing' as const, tone: 'waiting' as const }
    case 'merged':
      return { key: 'merge.statusMerged' as const, tone: 'working' as const }
    case 'failed':
    case 'terminal_error':
      return { key: 'merge.statusBlocked' as const, tone: 'offline' as const }
    default:
      return { key: 'merge.statusReady' as const, tone: 'stopped' as const }
  }
}

export function SidebarMergePanel() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const pushToast = useUiStore((s) => s.pushToast)
  const createTerminal = useProjectsStore((s) => s.createTerminal)
  const deleteTerminal = useProjectsStore((s) => s.deleteTerminal)

  const mergePhase = useMergeStore((s) => s.phase)
  const mergeProjectId = useMergeStore((s) => s.projectId)
  const mergeWorktreeAgentId = useMergeStore((s) => s.worktreeAgentId)
  const mergeError = useMergeStore((s) => s.error)
  const mergeOutcome = useMergeStore((s) => s.outcome)
  const mergeIsFinalizing = useMergeStore((s) => s.isFinalizing)
  const integrateWorktree = useMergeStore((s) => s.integrateWorktree)
  const validateResolution = useMergeStore((s) => s.validate)
  const finalizeResolution = useMergeStore((s) => s.finalize)
  const abortMerge = useMergeStore((s) => s.abort)

  const [testModalTarget, setTestModalTarget] = useState<PendingMergeCard | null>(null)
  const [commitConfirmTarget, setCommitConfirmTarget] = useState<{
    item: PendingMergeCard
    repo: string
    pending: WorktreePendingChange[]
    defaultMessage: string
  } | null>(null)
  const [testBriefing, setTestBriefing] = useState<{
    id: string
    /** null = ainda carregando o diff real. */
    diff: DiffSummaryEntry[] | null
    validation: 'idle' | 'loading' | ValidationResult
    /** Passos de teste estruturados, registrados pela sessão-filha via tool
     *  dedicada (`gsd_record_step`) — null = ainda carregando; [] = sem
     *  planejamento GSD nesse projeto (cai no fallback determinístico). */
    procedure: GsdProcedureStep[] | null
  } | null>(null)
  const [validatingId, setValidatingId] = useState<string | null>(null)
  const [reviewSessions, setReviewSessions] = useState<
    Record<string, { terminalId: string; tabId: string }>
  >({})
  const [reviewInputId, setReviewInputId] = useState<string | null>(null)
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [gateStatus, setGateStatus] = useState<Record<string, GateResult>>({})
  const probingRef = useRef<Set<string>>(new Set())

  // Coleta todas as worktrees ativas dos projetos que possuem alterações/branches
  // pendentes. useMemo evita identidade nova de array a cada render — sem isso,
  // o efeito de poll do Gate GSD (abaixo) dispararia sem parar.
  const pendingMerges: PendingMergeCard[] = useMemo(() => {
    const result: PendingMergeCard[] = []
    for (const proj of projects) {
      const repo = getProjectRepoRoot(proj)
      if (!repo) continue
      for (const term of proj.terminals) {
        if (term.worktreeAgentId && term.cwd && term.cwd !== repo) {
          result.push({
            id: `${proj.id}-${term.id}`,
            projectId: proj.id,
            projectName: proj.name,
            terminalId: term.id,
            worktreeAgentId: term.worktreeAgentId,
            branchName: `alethe/agent-${term.worktreeAgentId}`,
            worktreePath: term.cwd,
            agentName: term.name,
            gsdWatcherEnabled: Boolean(proj.gsdWatcherEnabled),
            gsdGateApplicable: term.tabs.some((tab) => tab.type === 'opencode'),
          })
        }
      }
    }
    return result
  }, [projects])

  /** Gate de Conclusão de Planejamento GSD — só roda pra cards de projetos com
   *  `gsdWatcherEnabled`. Camada 1 (planejamento completo, `.planning/STATE.md`/
   *  `roadmap.md` na PRÓPRIA worktree) decide se o card fica escondido; só
   *  quando ela passa, roda Camada 2 (diff real existe) e Camada 3 (validação
   *  passa). Falha em 2/3 NUNCA esconde o card — mostra com status de falha,
   *  porque esconder um problema real seria pior que mostrá-lo. `probingRef`
   *  evita disparo duplicado se o poll seguinte disparar antes da promise
   *  anterior resolver. */
  const checkCard = async (item: PendingMergeCard) => {
    if (probingRef.current.has(item.id)) return
    probingRef.current.add(item.id)
    setGateStatus((prev) => ({
      ...prev,
      [item.id]: prev[item.id]?.stage === 'failed' ? prev[item.id] : { stage: 'checking' },
    }))
    try {
      // Camada 1 (planejamento GSD) não bloqueia o card: mesmo com
      // `item.gsdGateApplicable`, um planejamento ainda em andamento não
      // esconde nem trava o card pra sempre — a Camada 2 (diff real) abaixo
      // já decide isso sozinha, então não há checagem de planejamento aqui.
      const proj = projects.find((p) => p.id === item.projectId)
      const repo = proj ? getProjectRepoRoot(proj) : ''
      if (!repo) {
        setGateStatus((prev) => ({ ...prev, [item.id]: { stage: 'hidden' } }))
        return
      }
      let target = 'main'
      try {
        target = (await gitStatus(repo)).branch
      } catch {
        // sem repo resolvível / gitStatus falhou — segue com o fallback 'main'
      }
      const diff = await gitDiffSummary(repo, item.branchName, target, item.worktreePath).catch(
        () => [],
      )
      if (diff.length === 0) {
        setGateStatus((prev) => ({
          ...prev,
          [item.id]: {
            stage: 'failed',
            detail: t('merge.gateFailedDiffEmpty', { branch: item.branchName, target }),
          },
        }))
        return
      }

      const commands = proj?.validationCommands ?? []
      if (commands.length === 0) {
        setGateStatus((prev) => ({ ...prev, [item.id]: { stage: 'ready' } }))
        return
      }
      try {
        const result = await runValidation(item.worktreePath, commands)
        setGateStatus((prev) => ({
          ...prev,
          [item.id]: result.success
            ? { stage: 'ready' }
            : {
                stage: 'failed',
                detail: t('merge.gateFailedValidation', {
                  stage: result.stage,
                  output: result.output.slice(0, 240),
                }),
              },
        }))
      } catch (err) {
        setGateStatus((prev) => ({
          ...prev,
          [item.id]: {
            stage: 'failed',
            detail: t('merge.gateFailedValidation', { stage: 'run', output: String(err) }),
          },
        }))
      }
    } finally {
      probingRef.current.delete(item.id)
    }
  }

  useEffect(() => {
    const gatedPending = pendingMerges.filter((item) => {
      if (!item.gsdWatcherEnabled) return false
      const stage = gateStatus[item.id]?.stage
      return !stage || stage === 'hidden' || stage === 'checking'
    })
    if (gatedPending.length === 0) return

    for (const item of gatedPending) {
      if (!gateStatus[item.id]) void checkCard(item)
    }
    const interval = setInterval(() => {
      for (const item of gatedPending) void checkCard(item)
    }, 8000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMerges, gateStatus])

  // Descoberta da sessão-filha isolada e leitura de status (busy/erro) —
  // extraída pro hook `useGsdSyncSessions` (usado também pela gaveta GSD
  // Sync). A pane "GSD Sync" NUNCA é aberta sozinha na grade normal do
  // projeto aqui; abrir é uma ação explícita do usuário só pela gaveta.
  useGsdSyncSessionsWatcher((_session, childError) => {
    // Defesa: no modo web, uma rota de backend ainda não implementada
    // devolve um JSON genérico `{status, path}` em vez do texto de erro real
    // — sem essa checagem, `childError` vira um objeto e `.slice` explode em
    // loop a cada poll (5s), inundando o console mesmo sem nenhum erro real.
    const message = typeof childError === 'string' ? childError : JSON.stringify(childError)
    pushToast({
      title: t('merge.gsdChildErrorTitle'),
      body: t('merge.gsdChildErrorBody', { error: message.slice(0, 300) }),
    })
  })

  const visiblePendingMerges = pendingMerges.filter((item) => {
    if (!item.gsdWatcherEnabled) return true
    const stage = gateStatus[item.id]?.stage
    return stage === 'ready' || stage === 'failed' || !stage || stage === 'checking'
  })

  const isMergeBusy = MERGE_BUSY_PHASES.includes(mergePhase)
  const activeCard = pendingMerges.find(
    (m) => m.projectId === mergeProjectId && m.worktreeAgentId === mergeWorktreeAgentId,
  )

  const handleAcceptMerge = async (item: PendingMergeCard) => {
    const proj = projects.find((p) => p.id === item.projectId)
    if (!proj) return
    const repo = getProjectRepoRoot(proj)
    if (!repo) {
      pushToast({ title: t('merge.noRepoTitle'), body: t('merge.noRepoBody') })
      return
    }
    // git merge só move commits — se essa worktree tem trabalho nunca
    // commitado, para e pede confirmação (com a mensagem do commit) antes de
    // seguir, em vez de commitar silenciosamente ou integrar um no-op (bug
    // real, confirmado ao vivo: "merge concluído" sem mover nada).
    const pending = await worktreePendingChanges(repo, item.worktreeAgentId).catch(() => [])
    if (pending.length > 0) {
      const defaultMessage = await readTextFile(`${item.worktreePath}/.planning/goal.md`).catch(
        () => '',
      )
      setCommitConfirmTarget({ item, repo, pending, defaultMessage: defaultMessage.trim() })
      return
    }
    await integrateWorktree(proj, repo, item.worktreeAgentId, item.terminalId)
  }

  const handleConfirmCommitAndIntegrate = async (message: string) => {
    const target = commitConfirmTarget
    if (!target) return
    setCommitConfirmTarget(null)
    const proj = projects.find((p) => p.id === target.item.projectId)
    if (!proj) return
    await worktreeCommitWorktree(target.repo, target.item.worktreeAgentId, message).catch((err) => {
      pushToast({
        title: t('merge.blockedTitle', { stage: 'commit' }),
        body: String(err).slice(0, 300),
      })
    })
    await integrateWorktree(proj, target.repo, target.item.worktreeAgentId, target.item.terminalId)
  }

  const handleRejectMerge = async (item: PendingMergeCard) => {
    const proj = projects.find((p) => p.id === item.projectId)
    if (!proj) return
    const repo = getProjectRepoRoot(proj)
    if (!repo) return
    if (!confirm(t('merge.rejectConfirm', { branch: item.branchName }))) return

    try {
      // Mata o processo/PTY do agente ANTES de remover a worktree — no Windows,
      // apagar uma pasta que ainda é o cwd de um processo vivo falha com
      // "failed to delete <path>" (é exatamente esse o erro que motivou este
      // fix). Espera de verdade a árvore de processos morrer via
      // `killPtyTree`/`kill_pty_tree_cmd`, não o `killPty` fire-and-forget que
      // `deleteTerminal` dispara (sem garantia de ordem).
      const terminal = proj.terminals.find((term) => term.id === item.terminalId)
      const ptyIds = (terminal?.tabs ?? [])
        .map((tab) => tab.ptyId)
        .filter((id): id is string => Boolean(id))
      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))

      // Só remove a worktree — a branch é preservada de propósito (worktree_remove
      // não apaga branch), diferente de Aceitar, que faz um merge real.
      await worktreeRemove(repo, item.worktreeAgentId, true)
      deleteTerminal(item.projectId, item.terminalId)
      pushToast({
        title: t('merge.rejectedTitle'),
        body: t('merge.rejectedBody', { branch: item.branchName }),
      })
    } catch (err) {
      // Falha real (não conseguiu matar o processo a tempo, lock
      // administrativo, disco, etc.) nunca pode deixar a worktree sem rastro
      // nenhum — registra como órfã (mesmo padrão de mergeStore.ts abort(),
      // linhas ~495-515) pro dono limpar depois via Editar Projeto →
      // Multi-Agentes, em vez de só um toast que some e a pasta ficar perdida.
      useProjectsStore.getState().addOrphanWorktree(item.projectId, {
        path: item.worktreePath,
        mode: 'gitWorktree',
      })
      pushToast({ title: t('merge.rejectFailedTitle'), body: String(err) })
    }
  }

  const handleRunValidation = async (item: PendingMergeCard) => {
    const proj = projects.find((p) => p.id === item.projectId)
    const commands = proj?.validationCommands ?? []
    if (commands.length === 0) {
      pushToast({
        title: t('merge.noValidationCommandsTitle'),
        body: t('merge.noValidationCommandsBody'),
      })
      return
    }
    setValidatingId(item.id)
    try {
      const result = await runValidation(item.worktreePath, commands)
      if (result.success) {
        pushToast({
          title: t('merge.validationPassedTitle'),
          body: t('merge.validationPassedBody'),
        })
      } else {
        pushToast({
          title: t('merge.validationFailedTitle'),
          body: `${result.stage}: ${result.output.slice(0, 300)}`,
        })
      }
    } catch (err) {
      pushToast({ title: t('merge.validationFailedTitle'), body: String(err) })
    } finally {
      setValidatingId(null)
    }
  }

  /** Spawna (ou reabre a caixa de feedback de) um agente revisor dedicado no
   *  próprio worktree do pane — reaproveita o mesmo mecanismo de terminal
   *  usado pelo agente efêmero de conflito, sem precisar de nenhum comando
   *  Rust novo. O feedback do usuário é digitado direto no stdin do agente
   *  já rodando (writePty), igual a um humano no terminal. */
  const handleToggleReview = async (item: PendingMergeCard) => {
    const existing = reviewSessions[item.id]
    if (existing) {
      setReviewInputId((cur) => (cur === item.id ? null : item.id))
      return
    }

    const proj = projects.find((p) => p.id === item.projectId)
    if (!proj) return
    const repo = getProjectRepoRoot(proj)
    let target = 'main'
    try {
      if (repo) target = (await gitStatus(repo)).branch
    } catch {
      // sem repo resolvível / gitStatus falhou — segue com o fallback 'main'
    }

    const provider = proj.reviewAgentProvider ?? proj.conflictAgentProvider ?? 'claude'
    const model = proj.reviewAgentModel ?? proj.conflictAgentModel

    const terminal = createTerminal(item.projectId, {
      name: `review-${item.agentName}`,
      cwd: item.worktreePath,
      firstTab: {
        type: provider,
        cwd: item.worktreePath,
        initialInput: reviewPrompt(item.branchName, target),
        extraArgs: model ? ['--model', model] : undefined,
      },
    })
    const tabId = terminal.tabs[0]?.id
    if (!tabId) return
    setReviewSessions((prev) => ({ ...prev, [item.id]: { terminalId: terminal.id, tabId } }))
    setReviewInputId(item.id)
    pushToast({ title: t('merge.reviewStartedTitle'), body: t('merge.reviewStartedBody') })
  }

  const handleSendReview = async (item: PendingMergeCard) => {
    const feedback = reviewFeedback.trim()
    const session = reviewSessions[item.id]
    if (!feedback || !session) return

    const proj = useProjectsStore.getState().projects.find((p) => p.id === item.projectId)
    const term = proj?.terminals.find((t) => t.id === session.terminalId)
    const tab = term?.tabs.find((t) => t.id === session.tabId)
    if (!tab?.ptyId) {
      pushToast({ title: t('merge.reviewNotReadyTitle'), body: t('merge.reviewNotReadyBody') })
      return
    }

    try {
      await writePty(tab.ptyId, `${feedback}\r`)
      setReviewFeedback('')
      setReviewInputId(null)
      pushToast({
        title: t('merge.reviewFeedbackSentTitle'),
        body: t('merge.reviewFeedbackSentBody'),
      })
    } catch (err) {
      pushToast({ title: t('merge.reviewNotReadyTitle'), body: String(err) })
    }
  }

  const handleStartTesting = (item: PendingMergeCard) => {
    createTerminal(item.projectId, {
      name: `test-${item.agentName}`,
      cwd: item.worktreePath,
      firstTab: { type: 'shell', cwd: item.worktreePath },
    })
    pushToast({
      title: t('merge.testingStartedTitle'),
      body: t('merge.testingStartedBody', { branch: item.branchName }),
    })
  }

  /** Abre o Briefing de Testes com dado real: diff de arquivos alterados
   *  (git de verdade) + resultado real dos validationCommands do projeto —
   *  nada de texto fabricado. As duas chamadas rodam em paralelo; cada
   *  atualização de estado confere `prev?.id === item.id` pra não pisar no
   *  resultado se o usuário trocar de card antes das respostas chegarem. */
  const handleOpenTestModal = (item: PendingMergeCard) => {
    setTestModalTarget(item)
    const proj = projects.find((p) => p.id === item.projectId)
    const commands = proj?.validationCommands ?? []
    const repo = proj ? getProjectRepoRoot(proj) : ''
    setTestBriefing({
      id: item.id,
      diff: repo ? null : [],
      validation: commands.length > 0 ? 'loading' : 'idle',
      procedure: null,
    })

    if (repo) {
      void (async () => {
        let target = 'main'
        try {
          target = (await gitStatus(repo)).branch
        } catch {
          // sem repo resolvível / gitStatus falhou — segue com o fallback 'main'
        }
        try {
          const diff = await gitDiffSummary(repo, item.branchName, target, item.worktreePath)
          setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, diff } : prev))
        } catch {
          setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, diff: [] } : prev))
        }
      })()
    }

    if (commands.length > 0) {
      runValidation(item.worktreePath, commands)
        .then((result) =>
          setTestBriefing((prev) =>
            prev?.id === item.id ? { ...prev, validation: result } : prev,
          ),
        )
        .catch((err) =>
          setTestBriefing((prev) =>
            prev?.id === item.id
              ? { ...prev, validation: { success: false, stage: 'run', output: String(err) } }
              : prev,
          ),
        )
    }

    // Procedimento de teste estruturado, registrado pela sessão-filha via
    // tool dedicada (gsd_record_step) — nunca por parsing de markdown solto.
    // Lista vazia: sem planejamento GSD nesse projeto (ou ciclo ainda não
    // rodou), o modal cai no fallback determinístico que já existia antes.
    readGsdProcedure(item.worktreePath)
      .then((procedure) =>
        setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, procedure } : prev)),
      )
      .catch(() =>
        setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, procedure: [] } : prev)),
      )
  }

  /** Envia o checklist de confirmação humana (passou/falhou + notas) direto
   *  pro terminal do agente — reaproveita o MESMO mecanismo do Revisor de
   *  Branch (writePty no ptyId já vivo), sem inventar arquivo/convenção
   *  nova. Se o terminal não estiver mais aberto/vivo, avisa em vez de falhar
   *  silenciosamente. */
  const handleSendTestFeedback = async (item: PendingMergeCard, summary: string) => {
    const proj = useProjectsStore.getState().projects.find((p) => p.id === item.projectId)
    const term = proj?.terminals.find((t) => t.id === item.terminalId)
    const tab = term?.tabs.find((t) => t.id === term.activeTabId) ?? term?.tabs[0]
    if (!tab?.ptyId) {
      pushToast({ title: t('merge.reviewNotReadyTitle'), body: t('merge.reviewNotReadyBody') })
      return
    }
    try {
      await writePty(tab.ptyId, `${summary}\r`)
      pushToast({ title: t('merge.testFeedbackSentTitle'), body: t('merge.testFeedbackSentBody') })
    } catch (err) {
      pushToast({ title: t('merge.reviewNotReadyTitle'), body: String(err) })
    }
  }

  return (
    <>
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.title}>
            <GitMerge size={14} color="var(--accent)" />
            <span>{t('merge.panelTitle')}</span>
          </div>
          <span className={styles.badge}>{visiblePendingMerges.length}</span>
        </div>

        {pendingMerges.length === 0 ? (
          <div className={styles.emptyState}>{t('merge.panelEmpty')}</div>
        ) : visiblePendingMerges.length === 0 ? (
          <div className={styles.emptyState}>
            {t('merge.panelGatedHint', { count: pendingMerges.length })}
          </div>
        ) : (
          visiblePendingMerges.map((item) => {
            const isCardActive = activeCard?.id === item.id
            const showStatusPanel = isCardActive && mergePhase !== 'idle'
            const buttonsDisabled = !isCardActive && isMergeBusy
            const gate = gateStatus[item.id]
            const status =
              !isCardActive && gate?.stage === 'failed'
                ? { key: 'merge.statusGateFailed' as const, tone: 'offline' as const }
                : statusInfo(mergePhase, isCardActive)
            const statusToneClass =
              status.tone === 'working'
                ? styles.statusWorking
                : status.tone === 'waiting'
                  ? styles.statusWaiting
                  : status.tone === 'offline'
                    ? styles.statusOffline
                    : styles.statusStopped

            return (
              <div key={item.id} className={styles.card}>
                <div className={styles.branchHeader}>
                  <span className={styles.branchName} title={item.branchName}>
                    {item.agentName} ({item.projectName})
                  </span>
                  <span className={`${styles.statusTag} ${statusToneClass}`}>{t(status.key)}</span>
                </div>

                {!showStatusPanel && gate?.stage === 'failed' ? (
                  <div className={styles.statusPanel}>
                    {gate.detail ? <p className={styles.statusDetail}>{gate.detail}</p> : null}
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => void checkCard(item)}
                    >
                      <RefreshCw size={12} />
                      {t('merge.gateRecheck')}
                    </button>
                  </div>
                ) : null}

                {showStatusPanel ? (
                  <div className={styles.statusPanel}>
                    {(mergePhase === 'failed' || mergePhase === 'terminal_error') &&
                    (mergeError || mergeOutcome?.output) ? (
                      <p className={styles.statusDetail}>
                        {(mergeError ?? mergeOutcome?.output ?? '').slice(0, 240)}
                      </p>
                    ) : null}
                    {mergePhase === 'resolving' ? (
                      <p className={styles.statusDetail}>{t('merge.resolvingHint')}</p>
                    ) : null}
                    {mergePhase === 'awaiting_review' ? (
                      <>
                        <p className={styles.statusDetail}>{t('merge.awaitingReviewHint')}</p>
                        {mergeOutcome && mergeOutcome.stage !== 'validated' ? (
                          <p className={styles.statusDetail}>{mergeOutcome.output.slice(0, 240)}</p>
                        ) : null}
                        <div className={styles.actionsGrid}>
                          <button
                            type="button"
                            className={`${styles.actionBtn} ${styles.btnValidate}`}
                            disabled={mergeIsFinalizing}
                            onClick={() => void validateResolution()}
                          >
                            <ShieldCheck size={12} />
                            <span className={styles.actionBtnLabel}>
                              {mergeIsFinalizing ? t('merge.validating') : t('merge.validate')}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.actionBtn} ${styles.btnAccept}`}
                            disabled={mergeIsFinalizing || mergeOutcome?.stage !== 'validated'}
                            onClick={() => void finalizeResolution()}
                            title={
                              mergeOutcome?.stage !== 'validated'
                                ? t('merge.validateBeforeIntegrateHint')
                                : undefined
                            }
                          >
                            <Check size={12} />
                            <span className={styles.actionBtnLabel}>{t('merge.integrate')}</span>
                          </button>
                        </div>
                      </>
                    ) : null}
                    {mergePhase !== 'merged' ? (
                      <button
                        type="button"
                        className={`${styles.actionBtn} ${styles.btnAbort}`}
                        onClick={() => void abortMerge()}
                      >
                        <X size={12} />
                        {t('merge.abort')}
                      </button>
                    ) : null}
                  </div>
                ) : reviewInputId === item.id ? (
                  <div className={styles.reviewBox}>
                    <textarea
                      className={styles.reviewTextarea}
                      placeholder={t('merge.reviewFeedbackPlaceholder')}
                      value={reviewFeedback}
                      onChange={(e) => setReviewFeedback(e.target.value)}
                    />
                    <div className={styles.reviewActions}>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => setReviewInputId(null)}
                      >
                        {t('merge.reviewFeedbackCancel')}
                      </button>
                      <button
                        type="button"
                        className={`${styles.actionBtn} ${styles.btnValidate}`}
                        onClick={() => void handleSendReview(item)}
                      >
                        {t('merge.reviewFeedbackSend')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.actionsGrid}>
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.btnAccept}`}
                      disabled={buttonsDisabled}
                      onClick={() => void handleAcceptMerge(item)}
                      title={t('merge.integrateTooltip')}
                    >
                      <Check size={12} />
                      <span className={styles.actionBtnLabel}>{t('merge.integrate')}</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.btnReject}`}
                      disabled={buttonsDisabled}
                      onClick={() => void handleRejectMerge(item)}
                      title={t('merge.rejectTooltip')}
                    >
                      <X size={12} />
                      <span className={styles.actionBtnLabel}>{t('merge.reject')}</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.btnValidate}`}
                      disabled={buttonsDisabled || validatingId === item.id}
                      onClick={() => void handleRunValidation(item)}
                      title={t('merge.validateTooltip')}
                    >
                      <ShieldCheck size={12} />
                      <span className={styles.actionBtnLabel}>
                        {validatingId === item.id ? t('merge.validating') : t('merge.validate')}
                      </span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.btnTest}`}
                      disabled={buttonsDisabled}
                      onClick={() => handleOpenTestModal(item)}
                      title={t('merge.testTooltip')}
                    >
                      <Play size={12} />
                      <span className={styles.actionBtnLabel}>{t('merge.test')}</span>
                    </button>

                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.btnReview}`}
                      disabled={buttonsDisabled}
                      onClick={() => void handleToggleReview(item)}
                      title={t('merge.reviewTooltip')}
                    >
                      <MessageSquare size={12} />
                      <span className={styles.actionBtnLabel}>{t('merge.review')}</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {testModalTarget ? (
        <BranchTestingModal
          open={Boolean(testModalTarget)}
          onClose={() => {
            setTestModalTarget(null)
            setTestBriefing(null)
          }}
          branchName={testModalTarget.branchName}
          projectName={testModalTarget.projectName}
          changesSummary={
            testBriefing?.diff === null
              ? [t('merge.testBriefingLoadingDiff')]
              : (testBriefing?.diff ?? []).map((entry) => `${entry.status} ${entry.path}`)
          }
          testingItems={
            testBriefing?.procedure && testBriefing.procedure.length > 0
              ? testBriefing.procedure.map((step, i): TestingItem => ({
                  id: `step-${i}`,
                  text: step.description,
                  category: step.category,
                }))
              : (testBriefing?.validation === 'loading'
                  ? (
                      projects.find((p) => p.id === testModalTarget.projectId)
                        ?.validationCommands ?? []
                    ).map((cmd) => t('merge.testBriefingRunning', { cmd }))
                  : testBriefing?.validation && testBriefing.validation !== 'idle'
                    ? testBriefing.validation.success
                      ? [t('merge.testBriefingValidationPassed')]
                      : [
                          t('merge.testBriefingValidationFailed', {
                            stage: testBriefing.validation.stage,
                            output: testBriefing.validation.output.slice(0, 300),
                          }),
                        ]
                    : [t('merge.testBriefingNoCommands')]
                ).map((text, i): TestingItem => ({ id: `fallback-${i}`, text }))
          }
          onStartTesting={() => handleStartTesting(testModalTarget)}
          onSendFeedback={(summary) => void handleSendTestFeedback(testModalTarget, summary)}
        />
      ) : null}

      {commitConfirmTarget ? (
        <ConfirmWorktreeCommitModal
          open={Boolean(commitConfirmTarget)}
          onClose={() => setCommitConfirmTarget(null)}
          branchName={commitConfirmTarget.item.branchName}
          pending={commitConfirmTarget.pending}
          defaultMessage={commitConfirmTarget.defaultMessage}
          onConfirm={(message) => void handleConfirmCommitAndIntegrate(message)}
        />
      ) : null}
    </>
  )
}
