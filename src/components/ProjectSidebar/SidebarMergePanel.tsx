import { ChevronDown, ChevronUp, GitMerge } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useGsdSyncSessionsWatcher } from '../../hooks/useGsdSyncSessions'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  type DiffSummaryEntry,
  gitDiffSummary,
  gitStatus,
  type GsdProcedureStep,
  healthProbe,
  type HealthProbeResult,
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
import type { AgentType } from '../../lib/types'
import { MERGE_BUSY_PHASES, type MergePhase, useMergeStore } from '../../stores/mergeStore'
import { getProjectRepoRoot, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { BranchTestingModal, type TestingItem } from '../modals/BranchTestingModal'
import { ConfirmWorktreeCommitModal } from '../modals/ConfirmWorktreeCommitModal'
import { MergeCenterModal } from '../modals/MergeCenterModal'
import { MergeTree } from './MergeTree'
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

export type PendingMergeCard = {
  id: string
  projectId: string
  projectName: string
  terminalId: string
  worktreeAgentId: string
  branchName: string
  worktreePath: string
  agentName: string
  /** Provider do agente rodando nessa worktree (tab ativa do terminal) — só
   *  pra escolher o ícone certo (AgentIcon), sem efeito nenhum no gate. */
  agentType: AgentType
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
export type GateStage = 'hidden' | 'checking' | 'ready' | 'failed' | 'unverified'
export type GateResult = { stage: GateStage; detail?: string }

/** Deriva o rótulo/tom do card a partir da fase real do mergeStore — só o
 *  card cujo worktreeAgentId bate com o merge ativo mostra progresso; os
 *  demais ficam neutros ("pronto para revisão"), sem prometer validação
 *  nenhuma que ainda não rodou. */
type CardStatus = { key: MessageKey; tone: 'working' | 'waiting' | 'offline' | 'stopped' }

export function statusInfo(phase: MergePhase, isActive: boolean): CardStatus {
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

/** Mesma decisão hoje calculada inline no `.map()` de render — extraída pra
 *  ser reaproveitada tanto pela linha compacta da árvore (MergeTree) quanto
 *  pela tag do popup de detalhe (MergeCenterModal), sem duplicar a lógica. */
export function deriveCardStatus(
  gate: GateResult | undefined,
  isCardActive: boolean,
  mergePhase: MergePhase,
): CardStatus {
  if (!isCardActive && gate?.stage === 'failed') {
    return { key: 'merge.statusGateFailed', tone: 'offline' }
  }
  if (!isCardActive && gate?.stage === 'unverified') {
    return { key: 'merge.statusUnverified', tone: 'waiting' }
  }
  return statusInfo(mergePhase, isCardActive)
}

export function SidebarMergePanel() {
  const t = useT()
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const terminalTheme = useProjectsStore((s) => s.preferences.terminalTheme ?? s.preferences.uiTheme)
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
    /** Camada 4 do Escudo — 'idle' quando não há `healthCheckCommand`
     *  configurado nesse projeto (nunca dispara sozinho). */
    health: 'idle' | 'loading' | HealthProbeResult
  } | null>(null)
  const [validatingId, setValidatingId] = useState<string | null>(null)
  const [reviewSessions, setReviewSessions] = useState<
    Record<string, { terminalId: string; tabId: string }>
  >({})
  const [reviewInputId, setReviewInputId] = useState<string | null>(null)
  const [reviewFeedback, setReviewFeedback] = useState('')
  const [gateStatus, setGateStatus] = useState<Record<string, GateResult>>({})
  const probingRef = useRef<Set<string>>(new Set())
  const [centerModalOpen, setCenterModalOpen] = useState(false)
  const [centerModalIndex, setCenterModalIndex] = useState(0)
  /** Painel some grande com muitas worktrees pendentes ao mesmo tempo — deixa
   *  o usuário recolher a árvore (cabeçalho/badge continuam visíveis) sem
   *  perder o sinal de que há merges pendentes. */
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  /** Altura total do painel (cabeçalho + árvore) — arrasta a alça no TOPO do
   *  painel pra empurrar a fronteira com a lista de projetos acima pra cima
   *  ou pra baixo. A lista de projetos é `flex:1` (ProjectSidebar.module.css
   *  `.list`), então crescer este painel automaticamente encolhe a lista —
   *  nunca sobrepõe, só divide o espaço. */
  const [panelHeight, setPanelHeight] = useState(220)
  const MIN_PANEL_HEIGHT = 90
  /** Altura só do cabeçalho+alça, quando recolhido — igual ao que o
   *  separador da sidebar direita (react-resizable-panels, ver App.tsx
   *  `collapsedSize="0px"`) faz ao recolher: some sempre é DE→PARA entre
   *  dois números com `height` animável, nunca um pulo pra `auto`. */
  const HEADER_ONLY_HEIGHT = 44
  /** true só durante o arrasto ativo — desliga a transição CSS de `height`
   *  pra ela seguir o ponteiro 1:1 (igual ao `:has([data-separator='active'])`
   *  de App.module.css), e liga de novo no pointerup pra o "encaixe" final
   *  (expandir/recolher) ficar suave em vez de instantâneo. */
  const [isResizingPanel, setIsResizingPanel] = useState(false)

  const handlePanelResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    // Limita a no máximo metade da altura real da sidebar no momento do
    // arrasto — garante que a lista de projetos acima (e o rodapé fixo
    // abaixo) sempre sobrem com espaço, em vez de deixar esse painel comer
    // a sidebar inteira.
    const asideEl = (e.currentTarget as HTMLElement).closest('aside')
    const maxHeight = asideEl
      ? Math.max(MIN_PANEL_HEIGHT + 40, asideEl.getBoundingClientRect().height * 0.5)
      : 480
    const startY = e.clientY
    const startHeight = treeCollapsed ? HEADER_ONLY_HEIGHT : panelHeight
    setIsResizingPanel(true)
    const onMove = (ev: PointerEvent) => {
      // Arrastar a alça do TOPO pra CIMA (mouse sobe, deltaY negativo) deve
      // AUMENTAR a altura do painel — por isso o sinal invertido aqui.
      const raw = startHeight - (ev.clientY - startY)
      // Arrastar além do limite mínimo recolhe de vez (mesmo estado do
      // clique no cabeçalho), em vez de travar num sliver pequeno demais pra
      // ser útil. Se o usuário voltar a arrastar pra cima sem soltar, reabre
      // e retoma o resize normalmente — o gesto é reversível.
      if (raw < MIN_PANEL_HEIGHT) {
        setTreeCollapsed(true)
        return
      }
      setTreeCollapsed(false)
      setPanelHeight(Math.min(maxHeight, raw))
    }
    const onUp = () => {
      setIsResizingPanel(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

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
          const activeTab = term.tabs.find((tab) => tab.id === term.activeTabId) ?? term.tabs[0]
          result.push({
            id: `${proj.id}-${term.id}`,
            projectId: proj.id,
            projectName: proj.name,
            terminalId: term.id,
            worktreeAgentId: term.worktreeAgentId,
            branchName: `alethe/agent-${term.worktreeAgentId}`,
            worktreePath: term.cwd,
            agentName: term.name,
            agentType: activeTab?.type ?? 'shell',
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
        // Sem comandos configurados, nada foi de fato checado — não pode
        // virar o mesmo selo verde de "passou" (era exatamente isso que
        // fazia o gate mentir que validou quando não validou nada).
        setGateStatus((prev) => ({ ...prev, [item.id]: { stage: 'unverified' } }))
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
    return (
      stage === 'ready' ||
      stage === 'failed' ||
      stage === 'unverified' ||
      !stage ||
      stage === 'checking'
    )
  })

  // Recorte só pra árvore da sidebar — o popup de detalhe continua navegando
  // por `visiblePendingMerges` inteiro (todos os projetos); só a árvore fica
  // escopada ao projeto selecionado no momento.
  const treeItemsForActiveProject = visiblePendingMerges.filter(
    (item) => item.projectId === activeProjectId,
  )
  const hasOtherProjectsPending = visiblePendingMerges.some(
    (item) => item.projectId !== activeProjectId,
  )

  const isMergeBusy = MERGE_BUSY_PHASES.includes(mergePhase)
  const activeCard = pendingMerges.find(
    (m) => m.projectId === mergeProjectId && m.worktreeAgentId === mergeWorktreeAgentId,
  )

  const handleSelectCard = (item: PendingMergeCard) => {
    const idx = visiblePendingMerges.findIndex((i) => i.id === item.id)
    if (idx === -1) return
    setCenterModalIndex(idx)
    setCenterModalOpen(true)
  }

  /** Reabre o popup de detalhe no MESMO item depois que um modal aninhado
   *  (Testar / confirmação de commit) fecha — nunca empilha dois Dialog Radix
   *  ao mesmo tempo, então o Center sempre fecha antes de abrir o outro. */
  const reopenCenterModalFor = (item: PendingMergeCard) => {
    const idx = visiblePendingMerges.findIndex((i) => i.id === item.id)
    if (idx === -1) return
    setCenterModalIndex(idx)
    setCenterModalOpen(true)
  }

  const handleAcceptMerge = async (item: PendingMergeCard) => {
    // Clicar em Integrar sempre fecha o popup de detalhe — pedido explícito
    // do dono, não fica esperando o usuário fechar na mão.
    setCenterModalOpen(false)
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
      // Popup já fechado no topo da função — só empilha o modal de
      // confirmação de commit (nunca dois Dialog Radix abertos ao mesmo
      // tempo).
      setCommitConfirmTarget({ item, repo, pending, defaultMessage: defaultMessage.trim() })
      return
    }
    await integrateWorktree(proj, repo, item.worktreeAgentId, item.terminalId)
  }

  const handleConfirmCommitAndIntegrate = async (message: string) => {
    const target = commitConfirmTarget
    if (!target) return
    setCommitConfirmTarget(null)
    // Confirmar o commit segue direto pro integrate de verdade — o popup de
    // detalhe já estava fechado desde o clique em Integrar, e continua
    // fechado (mesma regra: Integrar sempre fecha, não reabre sozinho).
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
    // Idem: fecha o popup de detalhe só depois do confirm nativo passar.
    setCenterModalOpen(false)

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
      ephemeralUtility: true,
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
      ephemeralUtility: true,
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
    // Fecha o popup de detalhe antes de empilhar o Briefing de Testes — nunca
    // dois Dialog Radix abertos ao mesmo tempo (ver reopenCenterModalFor).
    setCenterModalOpen(false)
    setTestModalTarget(item)
    const proj = projects.find((p) => p.id === item.projectId)
    const commands = proj?.validationCommands ?? []
    const repo = proj ? getProjectRepoRoot(proj) : ''
    const healthCommand = proj?.healthCheckCommand?.trim()
    setTestBriefing({
      id: item.id,
      diff: repo ? null : [],
      validation: commands.length > 0 ? 'loading' : 'idle',
      procedure: null,
      health: healthCommand ? 'loading' : 'idle',
    })

    if (healthCommand) {
      healthProbe(item.worktreePath, healthCommand, proj?.healthCheckPath?.trim() || '/', 8000)
        .then((result) =>
          setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, health: result } : prev)),
        )
        .catch((err) =>
          setTestBriefing((prev) =>
            prev?.id === item.id
              ? {
                  ...prev,
                  health: {
                    started: false,
                    responded: false,
                    statusCode: null,
                    elapsedMs: 0,
                    outputTail: String(err),
                    terminalVerified: null,
                  },
                }
              : prev,
          ),
        )
    }

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
              ? {
                  ...prev,
                  validation: { success: false, stage: 'run', output: String(err), ranAnyCommand: true },
                }
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
      <div
        className={styles.container}
        style={{
          height: treeCollapsed ? HEADER_ONLY_HEIGHT : panelHeight,
          transitionProperty: isResizingPanel ? 'none' : undefined,
        }}
      >
        {/* Sempre montada, mesmo recolhido — arrastar pra cima a partir do
            cabeçalho recolhido já reabre e retoma o resize (mesma lógica
            reversível do onMove em handlePanelResizeStart). */}
        <div
          className={styles.resizeHandle}
          onPointerDown={handlePanelResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('merge.treeResizeHandle')}
        />

        <div
          className={styles.header}
          role="button"
          tabIndex={0}
          onClick={() => setTreeCollapsed((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setTreeCollapsed((v) => !v)
            }
          }}
          aria-expanded={!treeCollapsed}
        >
          <div className={styles.title}>
            <GitMerge size={14} color="var(--accent)" />
            <span>{t('merge.panelTitle')}</span>
          </div>
          <div className={styles.headerRight}>
            <span className={styles.badge}>{visiblePendingMerges.length}</span>
            {treeCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </div>
        </div>

        {/* Sempre montada (mesmo recolhido) — anima opacidade/deslocamento
            junto com a altura do .container encolhendo, em vez de sumir
            de golpe no unmount (mesmo espírito do .sidebarContent[data-hidden]
            de App.module.css pro drawer direito). */}
        <div className={styles.body} data-hidden={treeCollapsed}>
          {pendingMerges.length === 0 ? (
            <div className={styles.emptyState}>{t('merge.panelEmpty')}</div>
          ) : visiblePendingMerges.length === 0 ? (
            <div className={styles.emptyState}>
              {t('merge.panelGatedHint', { count: pendingMerges.length })}
            </div>
          ) : (
            <MergeTree
              items={treeItemsForActiveProject}
              gateStatus={gateStatus}
              mergePhase={mergePhase}
              activeCardId={activeCard?.id ?? null}
              terminalTheme={terminalTheme}
              hasOtherProjectsPending={hasOtherProjectsPending}
              onSelect={handleSelectCard}
            />
          )}
        </div>
      </div>

      {centerModalOpen ? (
        <MergeCenterModal
          open={centerModalOpen}
          onClose={() => setCenterModalOpen(false)}
          items={visiblePendingMerges}
          initialIndex={centerModalIndex}
          gateStatus={gateStatus}
          terminalTheme={terminalTheme}
          mergePhase={mergePhase}
          mergeProjectId={mergeProjectId}
          mergeWorktreeAgentId={mergeWorktreeAgentId}
          mergeError={mergeError}
          mergeOutcome={mergeOutcome}
          mergeIsFinalizing={mergeIsFinalizing}
          isMergeBusy={isMergeBusy}
          onValidateResolution={() => void validateResolution()}
          onFinalizeResolution={() => void finalizeResolution()}
          onAbortMerge={() => void abortMerge()}
          reviewInputId={reviewInputId}
          reviewFeedback={reviewFeedback}
          onReviewFeedbackChange={setReviewFeedback}
          onCancelReview={() => setReviewInputId(null)}
          onToggleReview={(item) => void handleToggleReview(item)}
          onSendReview={(item) => void handleSendReview(item)}
          onAccept={(item) => void handleAcceptMerge(item)}
          onReject={(item) => void handleRejectMerge(item)}
          onValidate={(item) => void handleRunValidation(item)}
          validatingId={validatingId}
          onOpenTest={handleOpenTestModal}
          onRecheckGate={(item) => void checkCard(item)}
        />
      ) : null}

      {testModalTarget ? (
        <BranchTestingModal
          open={Boolean(testModalTarget)}
          onClose={() => {
            const reopenItem = testModalTarget
            setTestModalTarget(null)
            setTestBriefing(null)
            reopenCenterModalFor(reopenItem)
          }}
          branchName={testModalTarget.branchName}
          projectName={testModalTarget.projectName}
          changesSummary={
            testBriefing?.diff === null
              ? [t('merge.testBriefingLoadingDiff')]
              : (testBriefing?.diff ?? []).map((entry) => `${entry.status} ${entry.path}`)
          }
          healthState={
            testBriefing?.health === 'idle' || testBriefing?.health === undefined
              ? 'idle'
              : testBriefing.health === 'loading'
                ? 'loading'
                : testBriefing.health.responded && testBriefing.health.terminalVerified !== false
                  ? 'ok'
                  : 'warn'
          }
          healthSummary={
            testBriefing?.health === 'idle' || testBriefing?.health === undefined
              ? [t('merge.testHealthNotConfigured')]
              : testBriefing.health === 'loading'
                ? [t('merge.testHealthLoading')]
                : testBriefing.health.responded
                  ? [
                      t('merge.testHealthResponded', {
                        ms: testBriefing.health.elapsedMs,
                        status: String(testBriefing.health.statusCode ?? '—'),
                      }),
                      ...(testBriefing.health.terminalVerified === true
                        ? [t('merge.testHealthTerminalVerified')]
                        : testBriefing.health.terminalVerified === false
                          ? [t('merge.testHealthTerminalFailed')]
                          : []),
                    ]
                  : [
                      t('merge.testHealthNoResponse', {
                        ms: testBriefing.health.elapsedMs,
                        output: testBriefing.health.outputTail.slice(0, 300),
                      }),
                    ]
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
          onClose={() => {
            const reopenItem = commitConfirmTarget.item
            setCommitConfirmTarget(null)
            reopenCenterModalFor(reopenItem)
          }}
          branchName={commitConfirmTarget.item.branchName}
          pending={commitConfirmTarget.pending}
          defaultMessage={commitConfirmTarget.defaultMessage}
          onConfirm={(message) => void handleConfirmCommitAndIntegrate(message)}
        />
      ) : null}
    </>
  )
}
