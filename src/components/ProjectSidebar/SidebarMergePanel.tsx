import { ChevronDown, ChevronUp, GitMerge } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useGsdSyncSessionsWatcher } from '../../hooks/useGsdSyncSessions'
import { type MessageKey, useT } from '../../lib/i18n'
import {
  detectProjectStack,
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

/** Initial prompt for the Branch Reviewer — agent-facing (appears in its own
 *  terminal, not in the Alethe UI), so it lives outside i18n, same as
 *  conflictPrompt() in mergeStore. Doesn't implement/fix anything on its
 *  own — only evaluates and responds to the user in its own terminal. */
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
  /** Provider of the agent running in this worktree (terminal's active tab)
   *  — only used to pick the right icon (AgentIcon), has no effect on the gate. */
  agentType: AgentType
  gsdWatcherEnabled: boolean
  /** false when this worktree's provider isn't OpenCode — the GSD plugin
   *  (which writes `.planning/status.md`) is only installed in OpenCode
   *  terminals, so gate Layer 1 could never pass here. */
  gsdGateApplicable: boolean
}

/** Stages of the GSD Planning Completion Gate (opt-in via
 *  `gsdWatcherEnabled`) — `hidden`/`checking` never show up in the list,
 *  only `ready`/`failed`. `failed` means "planning says complete, but the
 *  automatic check (real diff or validation) didn't confirm it" — shown,
 *  never hidden, because hiding a real problem is worse than showing it. */
export type GateStage = 'hidden' | 'checking' | 'ready' | 'failed' | 'unverified'
export type GateResult = { stage: GateStage; detail?: string }

/** Derives the card's label/tone from mergeStore's real phase — only the
 *  card whose worktreeAgentId matches the active merge shows progress; the
 *  others stay neutral ("ready for review"), without promising any
 *  validation that hasn't run yet. */
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

/** Same decision that used to be computed inline in the render `.map()` —
 *  extracted so it can be reused both by the tree's compact row (MergeTree)
 *  and by the detail popup's tag (MergeCenterModal), without duplicating the logic. */
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
  const terminalTheme = useProjectsStore(
    (s) => s.preferences.terminalTheme ?? s.preferences.uiTheme,
  )
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
    /** null = still loading the real diff. */
    diff: DiffSummaryEntry[] | null
    validation: 'idle' | 'loading' | ValidationResult
    /** Structured test steps, recorded by the child session via a dedicated
     *  tool (`gsd_record_step`) — null = still loading; [] = no GSD planning
     *  in this project (falls back to the deterministic fallback). */
    procedure: GsdProcedureStep[] | null
    /** Shield Layer 4 — 'idle' when there's no `healthCheckCommand`
     *  configured on this project (never fires on its own). */
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
  /** Panel grows large with many pending worktrees at once — lets the user
   *  collapse the tree (header/badge stay visible) without losing the
   *  signal that there are pending merges. */
  const [treeCollapsed, setTreeCollapsed] = useState(false)
  /** Total panel height (header + tree) — dragging the handle at the TOP of
   *  the panel pushes the boundary with the project list above up or down.
   *  The project list is `flex:1` (ProjectSidebar.module.css `.list`), so
   *  growing this panel automatically shrinks the list — it never overlaps,
   *  it only divides the space. */
  const [panelHeight, setPanelHeight] = useState(220)
  const MIN_PANEL_HEIGHT = 90
  /** Height of just the header+handle, when collapsed — same as what the
   *  right sidebar separator (react-resizable-panels, see App.tsx
   *  `collapsedSize="0px"`) does on collapse: it always animates FROM→TO
   *  between two numbers with an animatable `height`, never a jump to `auto`. */
  const HEADER_ONLY_HEIGHT = 44
  /** true only during active dragging — turns off the CSS `height`
   *  transition so it follows the pointer 1:1 (same as
   *  `:has([data-separator='active'])` in App.module.css), and turns it
   *  back on on pointerup so the final "snap" (expand/collapse) feels
   *  smooth instead of instant. */
  const [isResizingPanel, setIsResizingPanel] = useState(false)

  const handlePanelResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    // Caps at at most half the sidebar's real height at drag time —
    // guarantees the project list above (and the fixed footer below)
    // always keep some room left, instead of letting this panel eat up
    // the whole sidebar.
    const asideEl = (e.currentTarget as HTMLElement).closest('aside')
    const maxHeight = asideEl
      ? Math.max(MIN_PANEL_HEIGHT + 40, asideEl.getBoundingClientRect().height * 0.5)
      : 480
    const startY = e.clientY
    const startHeight = treeCollapsed ? HEADER_ONLY_HEIGHT : panelHeight
    setIsResizingPanel(true)
    const onMove = (ev: PointerEvent) => {
      // Dragging the TOP handle UPWARD (mouse moves up, deltaY negative)
      // should INCREASE the panel's height — hence the inverted sign here.
      const raw = startHeight - (ev.clientY - startY)
      // Dragging past the minimum threshold collapses it outright (same
      // state as clicking the header), instead of getting stuck at a
      // sliver too small to be useful. If the user drags back up without
      // releasing, it reopens and resumes the resize normally — the gesture is reversible.
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

  // Collects all active worktrees from projects that have pending
  // changes/branches. useMemo avoids a new array identity on every render —
  // without this, the GSD Gate polling effect (below) would keep firing nonstop.
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

  /** GSD Planning Completion Gate — only runs for cards of projects with
   *  `gsdWatcherEnabled`. Layer 1 (complete planning, `.planning/STATE.md`/
   *  `roadmap.md` in the worktree ITSELF) decides whether the card stays
   *  hidden; only once it passes do Layer 2 (real diff exists) and Layer 3
   *  (validation passes) run. Failing 2/3 NEVER hides the card — it shows
   *  with a failed status, because hiding a real problem would be worse
   *  than showing it. `probingRef` prevents a duplicate fire if the next
   *  poll fires before the previous promise resolves. */
  const checkCard = async (item: PendingMergeCard) => {
    if (probingRef.current.has(item.id)) return
    probingRef.current.add(item.id)
    setGateStatus((prev) => ({
      ...prev,
      [item.id]: prev[item.id]?.stage === 'failed' ? prev[item.id] : { stage: 'checking' },
    }))
    try {
      // Layer 1 (GSD planning) doesn't block the card: even with
      // `item.gsdGateApplicable`, a planning still in progress doesn't hide
      // or lock the card forever — Layer 2 (real diff) below already
      // decides that on its own, so there's no planning check here.
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
        // no resolvable repo / gitStatus failed — proceed with the 'main' fallback
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
        // With no commands configured, nothing was actually checked — it
        // can't turn into the same green "passed" badge (that's exactly
        // what made the gate lie about validating when it validated nothing).
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

  // Isolated child session discovery and status reading (busy/error) —
  // extracted into the `useGsdSyncSessions` hook (also used by the GSD
  // Sync drawer). The "GSD Sync" pane is NEVER opened on its own in the
  // normal project grid here; opening it is an explicit user action from the drawer only.
  useGsdSyncSessionsWatcher((_session, childError) => {
    // Defense: in web mode, a backend route not yet implemented returns a
    // generic `{status, path}` JSON instead of the real error text —
    // without this check, `childError` becomes an object and `.slice`
    // blows up in a loop on every poll (5s), flooding the console even with no real error.
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

  // Slice used only for the sidebar tree — the detail popup keeps
  // navigating the whole `visiblePendingMerges` (all projects); only the
  // tree stays scoped to the currently selected project.
  const treeItemsForActiveProject = visiblePendingMerges.filter(
    (item) => item.projectId === activeProjectId,
  )
  const hasOtherProjectsPending = visiblePendingMerges.some(
    (item) => item.projectId !== activeProjectId,
  )
  // Explicit request: the Merge Center only takes up sidebar space when the
  // ACTIVE project has something pending — avoids competing for height with
  // the Commit Graph (same panel) when the pending merge belongs to a different project.
  const hasActiveProjectMerges = pendingMerges.some((item) => item.projectId === activeProjectId)

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

  /** Reopens the detail popup on the SAME item after a nested modal
   *  (Test / commit confirmation) closes — never stacks two Radix Dialogs
   *  at the same time, so the Center always closes before opening the other one. */
  const reopenCenterModalFor = (item: PendingMergeCard) => {
    const idx = visiblePendingMerges.findIndex((i) => i.id === item.id)
    if (idx === -1) return
    setCenterModalIndex(idx)
    setCenterModalOpen(true)
  }

  const handleAcceptMerge = async (item: PendingMergeCard) => {
    // Clicking Integrate always closes the detail popup — explicit request
    // from the owner, doesn't sit around waiting for the user to close it manually.
    setCenterModalOpen(false)
    const proj = projects.find((p) => p.id === item.projectId)
    if (!proj) return
    const repo = getProjectRepoRoot(proj)
    if (!repo) {
      pushToast({ title: t('merge.noRepoTitle'), body: t('merge.noRepoBody') })
      return
    }
    // git merge only moves commits — if this worktree has work that was
    // never committed, stop and ask for confirmation (with the commit
    // message) before proceeding, instead of committing silently or
    // integrating a no-op (real bug, confirmed live: "merge complete" without moving anything).
    const pending = await worktreePendingChanges(repo, item.worktreeAgentId).catch(() => [])
    if (pending.length > 0) {
      const defaultMessage = await readTextFile(`${item.worktreePath}/.planning/goal.md`).catch(
        () => '',
      )
      // Popup already closed at the top of the function — just stacks the
      // commit confirmation modal (never two Radix Dialogs open at the same time).
      setCommitConfirmTarget({ item, repo, pending, defaultMessage: defaultMessage.trim() })
      return
    }
    await integrateWorktree(proj, repo, item.worktreeAgentId, item.terminalId)
  }

  const handleConfirmCommitAndIntegrate = async (message: string) => {
    const target = commitConfirmTarget
    if (!target) return
    setCommitConfirmTarget(null)
    // Confirming the commit goes straight into the real integrate — the
    // detail popup was already closed since the click on Integrate, and
    // stays closed (same rule: Integrate always closes, never reopens on its own).
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
    // Same here: only closes the detail popup after the native confirm passes.
    setCenterModalOpen(false)

    try {
      // Kill the agent's process/PTY BEFORE removing the worktree — on
      // Windows, deleting a folder that's still the cwd of a live process
      // fails with "failed to delete <path>" (that's exactly the error that
      // motivated this fix). Actually waits for the process tree to die via
      // `killPtyTree`/`kill_pty_tree_cmd`, not the fire-and-forget `killPty`
      // that `deleteTerminal` fires (with no ordering guarantee).
      const terminal = proj.terminals.find((term) => term.id === item.terminalId)
      const ptyIds = (terminal?.tabs ?? [])
        .map((tab) => tab.ptyId)
        .filter((id): id is string => Boolean(id))
      await Promise.all(ptyIds.map((id) => killPtyTree(id).catch(() => [])))

      // Only removes the worktree — the branch is deliberately preserved
      // (worktree_remove doesn't delete the branch), unlike Accept, which does a real merge.
      await worktreeRemove(repo, item.worktreeAgentId, true)
      deleteTerminal(item.projectId, item.terminalId)
      pushToast({
        title: t('merge.rejectedTitle'),
        body: t('merge.rejectedBody', { branch: item.branchName }),
      })
    } catch (err) {
      // A real failure (couldn't kill the process in time, administrative
      // lock, disk, etc.) can never leave the worktree with no trace at all
      // — record it as orphaned (same pattern as mergeStore.ts abort(),
      // lines ~495-515) for the owner to clean up later via Edit Project →
      // Multi-Agents, instead of just a toast that disappears and the folder gets lost.
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

  /** Spawns (or reopens the feedback box for) a dedicated review agent in
   *  the pane's own worktree — reuses the same terminal mechanism used by
   *  the ephemeral conflict agent, with no new Rust command required. The
   *  user's feedback is typed directly into the running agent's stdin
   *  (writePty), just like a human would in the terminal. */
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
      // no resolvable repo / gitStatus failed — proceed with the 'main' fallback
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

  const handleStartTesting = async (item: PendingMergeCard) => {
    const proj = projects.find((p) => p.id === item.projectId)

    // 1. Look for explicit action/run commands in the procedure recorded by GSD
    let runCommand = testBriefing?.procedure
      ?.map((step) => {
        const match = /["'`](.+?)["'`]/.exec(step.description)
        return match ? match[1].trim() : null
      })
      .find((cmd): cmd is string => Boolean(cmd) && (cmd!.startsWith('go run') || cmd!.startsWith('npm') || cmd!.startsWith('cargo run') || cmd!.startsWith('python') || cmd!.startsWith('make') || cmd!.startsWith('go build')))

    if (runCommand && runCommand.startsWith('go build')) {
      // If it's "go build ./cmd/animego", chain the generated binary's execution right after
      const binName = runCommand.split('/').pop() || 'app'
      runCommand = `${runCommand} && .\\${binName}.exe`
    }

    // 2. If not in the procedure, look in healthCheck / validationCommands
    if (!runCommand) {
      runCommand = proj?.healthCheckCommand?.trim() || proj?.validationCommands?.[0]?.trim()
    }

    let initialInput: string | undefined = runCommand ? `${runCommand}\r` : undefined

    if (!initialInput) {
      try {
        const detection = await detectProjectStack(item.worktreePath)
        if (detection.suggestedCommands.length > 0) {
          initialInput = `${detection.suggestedCommands[0]}\r`
        }
      } catch {
        // fallback
      }
    }

    createTerminal(item.projectId, {
      name: `test-${item.agentName}`,
      cwd: item.worktreePath,
      firstTab: {
        type: 'shell',
        cwd: item.worktreePath,
        initialInput,
      },
      ephemeralUtility: true,
    })

    pushToast({
      title: t('merge.testingStartedTitle'),
      body: t('merge.testingStartedBody', { branch: item.branchName }),
    })
  }

  /** Opens the Test Briefing with real data: diff of changed files (actual
   *  git) + the project's real validationCommands result — no fabricated
   *  text. Both calls run in parallel; every state update checks
   *  `prev?.id === item.id` so it doesn't stomp on the result if the user
   *  switches cards before the responses arrive. */
  const handleOpenTestModal = (item: PendingMergeCard) => {
    // Closes the detail popup before stacking the Test Briefing — never two
    // Radix Dialogs open at the same time (see reopenCenterModalFor).
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
          // no resolvable repo / gitStatus failed — proceed with the 'main' fallback
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
                  validation: {
                    success: false,
                    stage: 'run',
                    output: String(err),
                    ranAnyCommand: true,
                  },
                }
              : prev,
          ),
        )
    }

    // Structured test procedure, recorded by the child session via a
    // dedicated tool (gsd_record_step) — never by parsing loose markdown.
    // Empty list: no GSD planning in this project (or the cycle hasn't run
    // yet), the modal falls back to the deterministic fallback that already existed before.
    readGsdProcedure(item.worktreePath)
      .then((procedure) =>
        setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, procedure } : prev)),
      )
      .catch(() =>
        setTestBriefing((prev) => (prev?.id === item.id ? { ...prev, procedure: [] } : prev)),
      )
  }

  /** Sends the human confirmation checklist (passed/failed + notes)
   *  straight to the agent's terminal — reuses the SAME mechanism as the
   *  Branch Reviewer (writePty on the already-live ptyId), without
   *  inventing a new file/convention. If the terminal is no longer
   *  open/alive, warns instead of failing silently. */
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
      {hasActiveProjectMerges ? (
        <div
          className={styles.container}
          style={{
            height: treeCollapsed ? HEADER_ONLY_HEIGHT : panelHeight,
            transitionProperty: isResizingPanel ? 'none' : undefined,
          }}
        >
          {/* Always mounted, even when collapsed — dragging up from the
              collapsed header already reopens and resumes the resize (same
              reversible logic as onMove in handlePanelResizeStart). */}
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
              <span className={styles.badge}>{treeItemsForActiveProject.length}</span>
              {treeCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </div>
          </div>

          {/* Always mounted (even when collapsed) — animates opacity/offset
              together with the .container height shrinking, instead of
              disappearing abruptly on unmount (same spirit as
              .sidebarContent[data-hidden] in App.module.css for the right drawer). */}
          <div className={styles.body} data-hidden={treeCollapsed}>
            {treeItemsForActiveProject.length === 0 ? (
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
      ) : null}

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
              : (testBriefing?.diff ?? [])
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
