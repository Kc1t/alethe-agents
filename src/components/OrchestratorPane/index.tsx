import { convertFileSrc } from '@tauri-apps/api/core'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FilePen,
  GitBranch,
  Minus,
  Network,
  Plus,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react'
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useOrchestratorQuotaWarnings } from '../../hooks/useOrchestratorQuotaWarnings'
import { formatReset } from '../../lib/agentCanvasUtils'
import { type MessageKey, type TFunction, useT } from '../../lib/i18n'
import {
  DOT_SPACING,
  fitView,
  focusView,
  type GraphNode,
  type LayoutShell,
  layoutPlannerBoard,
  mediaNodeId,
  type NodeHeights,
  rootNodeId,
  type ViewTransform,
  zoomAt,
} from '../../lib/orchestratorGraph'
import { extractMediaItems, splitPromotedMedia, type MediaItem } from '../../lib/orchestratorMedia'
import {
  type Attention,
  type AttentionLane,
  attentionOf,
  emptyCounts,
  groupPlanners,
  LANE_OF,
  type OrchestratorRun,
  type PlannerGroup,
  RUN_LANE_ORDER,
  type RunLane,
} from '../../lib/orchestratorRuns'
import { resolveShortcuts, renderShortcut, shortcutsForJob } from '../../lib/orchestratorShortcuts'
import { nativeSubagentJobs } from '../../lib/orchestratorSubagents'
import { basename } from '../../lib/paths'
import {
  listenOrchestratorJobs,
  orchestratorAnswer,
  orchestratorCancelJob,
  type OrchestratorDecision,
  type OrchestratorJob,
  orchestratorJobDiff,
  orchestratorJobs,
  type OrchestratorPendingApproval,
  orchestratorShellRemove,
  orchestratorShellRestart,
  orchestratorShellStop,
  type OrchestratorShell,
  type OrchestratorSnapshot,
} from '../../lib/tauri'
import {
  plannerTabActivity,
  type ShellAttachment,
  type ShellControl,
  shellsForBoard,
  shellTerminalPlan,
} from '../../lib/orchestratorShells'
import type { OrchestratorShortcut, Project, Terminal, Theme } from '../../lib/types'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from '../modals/Modal'
import { Collapse } from '../ui/Collapse'
import { writePtyChunked } from '../XTermView/terminalWrite'
import { AgentGlyph, contextShare, formatElapsed, formatTokens, statusTitle } from './nodeFormat'
import { OrchestratorInspector, type InspectorTarget } from './OrchestratorInspector'
import { ShellNode } from './ShellNode'
import styles from './OrchestratorPane.module.css'

const EMPTY: OrchestratorSnapshot = {
  jobs: [],
  planners: [],
  running: 0,
  queued: 0,
  concurrencyLimit: 0,
  shells: [],
}

const LIVE_TICK_MS = 1_000

const ZOOM_STEP = 1.2

const IDENTITY_VIEW: ViewTransform = { scale: 1, x: 0, y: 0 }

const LANE_LABEL: Record<RunLane, `orchestrator.lane.${RunLane}`> = {
  blocked: 'orchestrator.lane.blocked',
  running: 'orchestrator.lane.running',
  queued: 'orchestrator.lane.queued',
  interrupted: 'orchestrator.lane.interrupted',
  failed: 'orchestrator.lane.failed',
  finished: 'orchestrator.lane.finished',
}

const ATTENTION_LABEL: Record<AttentionLane, MessageKey> = {
  blocked: 'orchestrator.runBlocked',
  failed: 'orchestrator.runFailed',
  interrupted: 'orchestrator.runInterrupted',
}

const DECISIONS: { decision: OrchestratorDecision; label: MessageKey; hint: MessageKey }[] = [
  {
    decision: 'accept',
    label: 'orchestrator.answerAccept',
    hint: 'orchestrator.answerAcceptTitle',
  },
  {
    decision: 'acceptForSession',
    label: 'orchestrator.answerSession',
    hint: 'orchestrator.answerSessionTitle',
  },
  {
    decision: 'decline',
    label: 'orchestrator.answerDecline',
    hint: 'orchestrator.answerDeclineTitle',
  },
  { decision: 'abort', label: 'orchestrator.answerAbort', hint: 'orchestrator.answerAbortTitle' },
]

// A planner id is a terminal id, never empty, so the empty string can stand for the group of jobs
// that carry no planner at all.
function plannerKey(group: PlannerGroup): string {
  return group.id ?? ''
}

/** A worker's conclusion is the last thing it says: its opening line is narration, not a result. */
function latestLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** A live worker still holds a slot, so stopping it means something; native subagents have none. */
function canStop(job: OrchestratorJob): boolean {
  return (
    !job.native && (job.status === 'queued' || job.status === 'running' || job.status === 'blocked')
  )
}

function laneTitle(lane: RunLane, t: TFunction): string | undefined {
  if (lane === 'interrupted') return t('orchestrator.interruptedTitle')
  if (lane === 'blocked') return t('orchestrator.blockedTitle')
  return undefined
}

type AttentionRow = { group: PlannerGroup; attention: Attention }

// Blocked first: a failure is already over, a blocked worker is still holding a slot.
function attentionFirst(a: AttentionRow, b: AttentionRow): number {
  return Number(b.attention.lane === 'blocked') - Number(a.attention.lane === 'blocked')
}

// A finished run folds itself away; anything still live or still needing you opens on its own.
function opensByDefault(run: OrchestratorRun): boolean {
  return run.state !== 'finished'
}

type PlannerTarget = { projectId: string; terminalId: string }

// A planner id is the pty id of the terminal its agent runs in; that terminal is what to reveal.
function findPlannerTerminal(projects: Project[], ptyId: string): PlannerTarget | null {
  for (const project of projects) {
    for (const terminal of project.terminals) {
      if (terminal.tabs.some((tab) => tab.ptyId === ptyId)) {
        return { projectId: project.id, terminalId: terminal.id }
      }
    }
  }
  return null
}

type BindNode = (id: string, element: HTMLElement | null) => void

type AnswerFn = (id: string, decision: OrchestratorDecision) => void

type ApprovalAskProps = {
  job: OrchestratorJob
  ask: OrchestratorPendingApproval
  answering: boolean
  onAnswer: AnswerFn
  t: TFunction
}

/** Everything here comes off `pendingApproval`; nothing is inferred when a field is missing. */
function ApprovalAsk({ job, ask, answering, onAnswer, t }: ApprovalAskProps) {
  const elsewhere = ask.cwd && ask.cwd !== job.cwd ? ask.cwd : null

  return (
    <div className={styles.ask} onPointerDown={(event) => event.stopPropagation()}>
      <div className={styles.askHead}>
        <span className={styles.askIcon} aria-hidden>
          {ask.kind === 'fileChange' ? <FilePen size={11} /> : <TerminalIcon size={11} />}
        </span>
        <span>{t('orchestrator.askLabel')}</span>
      </div>

      <p className={styles.askWhat}>
        {t(ask.kind === 'fileChange' ? 'orchestrator.askFileChange' : 'orchestrator.askCommand')}
      </p>

      {ask.command && (
        <code className={styles.askCommand} title={ask.command}>
          {ask.command}
        </code>
      )}
      {ask.reason && <p className={styles.askReason}>{ask.reason}</p>}
      {elsewhere && (
        <span className={styles.askCwd} title={elsewhere}>
          {t('orchestrator.askIn', { path: elsewhere })}
        </span>
      )}

      <div className={styles.askActions}>
        {DECISIONS.map((entry) => (
          <button
            key={entry.decision}
            type="button"
            className={styles.askAction}
            data-decision={entry.decision}
            disabled={answering}
            title={t(entry.hint)}
            onClick={() => onAnswer(job.id, entry.decision)}
          >
            {t(entry.label)}
          </button>
        ))}
      </div>

      <p className={styles.askHint}>{t('orchestrator.askHint')}</p>
    </div>
  )
}

type WorkerNodeProps = {
  job: OrchestratorJob
  node: GraphNode
  selected: boolean
  answering: boolean
  theme: Theme
  shortcuts: readonly OrchestratorShortcut[]
  onSelect: (id: string) => void
  onAnswer: AnswerFn
  onStop: (id: string) => void
  onShortcut: (job: OrchestratorJob, shortcut: OrchestratorShortcut) => void
  bind: BindNode
  t: TFunction
}

function WorkerNode({
  job,
  node,
  selected,
  answering,
  theme,
  shortcuts,
  onSelect,
  onAnswer,
  onStop,
  onShortcut,
  bind,
  t,
}: WorkerNodeProps) {
  const share = contextShare(job)
  const tokens = formatTokens(job.tokens?.total?.totalTokens)
  const elapsed = formatElapsed(job.seconds)
  const live = latestLine(job.summary) || latestLine(job.spec)
  const stoppable = canStop(job)
  const applicableShortcuts = shortcutsForJob(shortcuts, job)

  return (
    <article
      ref={(element) => bind(job.id, element)}
      className={styles.worker}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-status={job.status}
      data-lane={LANE_OF[job.status]}
      data-selected={selected ? 'true' : undefined}
    >
      {(stoppable || applicableShortcuts.length > 0) && (
        <div className={styles.workerControls}>
          {stoppable && (
            <button
              type="button"
              className={styles.workerControlIcon}
              title={t('orchestrator.stopWorker')}
              aria-label={t('orchestrator.stopWorker')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onStop(job.id)}
            >
              <Square size={12} />
            </button>
          )}
          {applicableShortcuts.map((shortcut) => (
            <button
              key={shortcut.id}
              type="button"
              className={styles.workerControlLabel}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onShortcut(job, shortcut)}
            >
              {shortcut.name}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className={styles.workerCard}
        title={job.spec}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onSelect(job.id)}
      >
        <span className={styles.workerHead}>
          <AgentGlyph
            agent={job.agent}
            theme={theme}
            title={t('orchestrator.agentTitle', { agent: job.agent })}
            className={styles.glyph}
          />
          <span className={styles.dot} aria-hidden />
          <span className={styles.workerId}>{job.id}</span>
          {elapsed && <span className={styles.workerElapsed}>{elapsed}</span>}
        </span>

        {live && <span className={styles.workerLive}>{live}</span>}

        <span className={styles.meta}>
          <span className={styles.metaStatus} title={statusTitle(job.status, t)}>
            {t(`orchestrator.status.${job.status}`)}
          </span>
          {share !== null && (
            <span title={t('orchestrator.contextTitle', { percent: share })}>
              {t('orchestrator.contextChip', { value: share })}
            </span>
          )}
          {tokens && <span title={t('orchestrator.tokensTitle')}>{tokens}</span>}
          {job.worktree && (
            <span className={styles.metaIcon} title={job.worktree}>
              <GitBranch size={9} aria-hidden />
              {t('orchestrator.isolated')}
            </span>
          )}
          {job.hasDiff && <span>{t('orchestrator.hasDiff')}</span>}
        </span>
      </button>

      {job.status === 'blocked' && job.pendingApproval && (
        <ApprovalAsk
          job={job}
          ask={job.pendingApproval}
          answering={answering}
          onAnswer={onAnswer}
          t={t}
        />
      )}

      {job.status === 'failed' && job.outcome && (
        <div className={styles.errBar}>
          <span className={styles.errText} title={job.outcome}>
            {job.outcome}
          </span>
        </div>
      )}

      {share !== null && (
        <span
          className={styles.contextTrack}
          title={t('orchestrator.contextTitle', { percent: share })}
          aria-hidden
        >
          <i style={{ width: `${share}%` }} />
        </span>
      )}
    </article>
  )
}

type MediaCardNodeProps = {
  node: GraphNode
  item: MediaItem
  bind: BindNode
}

function MediaCardNode({ node, item, bind }: MediaCardNodeProps) {
  const [open, setOpen] = useState(false)
  const src = item.kind === 'image-local' ? convertFileSrc(item.value) : item.value

  return (
    <article
      ref={(element) => bind(node.id, element)}
      className={styles.media}
      style={{ left: node.x, top: node.y, width: node.width }}
    >
      <button
        type="button"
        className={styles.mediaCard}
        title={item.value}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen(true)}
      >
        <img className={styles.mediaCardImage} src={src} alt="" loading="lazy" />
        <span className={styles.mediaCaption}>{basename(item.value)}</span>
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title={basename(item.value)} width={720}>
          <div className={styles.mediaPreviewBody}>
            <img className={styles.mediaPreviewImage} src={src} alt="" />
            <div className={styles.mediaPreviewPath} title={item.value}>
              {item.value}
            </div>
          </div>
        </Modal>
      )}
    </article>
  )
}

type RunNodeProps = {
  run: OrchestratorRun
  node: GraphNode
  onClear: () => void
  bind: BindNode
  t: TFunction
}

function RunNode({ run, node, onClear, bind, t }: RunNodeProps) {
  const total = run.jobs.length

  return (
    <article
      ref={(element) => bind(node.id, element)}
      className={styles.run}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-lane={run.state}
    >
      <button
        type="button"
        className={styles.runCard}
        title={t('orchestrator.runNodeTitle')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClear}
      >
        <span className={styles.runEyebrow}>
          <span className={styles.dot} aria-hidden />
          <span className={styles.runKind}>{t('orchestrator.runEyebrow')}</span>
          <span className={styles.runState} title={laneTitle(run.state, t)}>
            {t(LANE_LABEL[run.state])}
          </span>
        </span>
        <span className={styles.runLabel}>{run.label}</span>
        <span className={styles.runFoot}>
          <span>{t('orchestrator.workerCount', { count: total })}</span>
          {run.rules ? <span title={t('orchestrator.runRulesTitle')}>{run.rules}</span> : null}
          {run.counts.blocked > 0 && (
            <em className={styles.runBlocked} title={t('orchestrator.blockedTitle')}>
              {t('orchestrator.runBlocked', { count: run.counts.blocked })}
            </em>
          )}
          <b>{t('orchestrator.runDone', { done: run.counts.finished, total })}</b>
        </span>
      </button>
    </article>
  )
}

type PlannerNodeProps = {
  group: PlannerGroup
  node: GraphNode
  theme: Theme
  onReveal: (() => void) | null
  bind: BindNode
  t: TFunction
}

function PlannerNode({ group, node, theme, onReveal, bind, t }: PlannerNodeProps) {
  const name = group.label ?? t('orchestrator.noPlanner')
  return (
    <article
      ref={(element) => bind(node.id, element)}
      className={styles.planner}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-lane={group.state}
    >
      <button
        type="button"
        className={styles.plannerCard}
        disabled={onReveal === null}
        title={onReveal ? t('orchestrator.plannerNodeTitle') : t('orchestrator.plannerGone')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onReveal?.()}
      >
        <AgentGlyph
          agent={group.agent}
          theme={theme}
          size={17}
          title={group.agent ? t('orchestrator.agentTitle', { agent: group.agent }) : undefined}
          className={styles.glyph}
        />
        <span className={styles.plannerText}>
          <span className={styles.plannerKind}>{t('orchestrator.plannerEyebrow')}</span>
          <span className={styles.plannerName}>{name}</span>
        </span>
        <span className={styles.plannerCount}>
          {t('orchestrator.runCount', { count: group.runs.length })}
        </span>
      </button>
    </article>
  )
}

type RailRowProps = {
  job: OrchestratorJob
  depth: number
  selected: boolean
  theme: Theme
  onSelect: (id: string) => void
  t: TFunction
}

function RailRow({ job, depth, selected, theme, onSelect, t }: RailRowProps) {
  const elapsed = formatElapsed(job.seconds)
  const lane = LANE_OF[job.status]
  // A blocked worker's clock is still running, but the state is what the row has to report.
  const value = lane === 'blocked' ? t(LANE_LABEL.blocked) : (elapsed ?? t(LANE_LABEL[lane]))
  return (
    <button
      type="button"
      className={styles.railRow}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-status={job.status}
      data-selected={selected ? 'true' : undefined}
      title={statusTitle(job.status, t) ?? t('orchestrator.selectWorker')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onSelect(job.id)}
    >
      <span className={styles.dot} aria-hidden />
      <AgentGlyph agent={job.agent} theme={theme} size={12} className={styles.glyph} />
      <span className={styles.railName}>{job.id}</span>
      <span className={styles.railValue}>{value}</span>
    </button>
  )
}

type RunBranchProps = {
  run: OrchestratorRun
  open: boolean
  selectedId: string | null
  theme: Theme
  onToggle: (id: string) => void
  onSelectWorker: (id: string) => void
  t: TFunction
}

function RunBranch({ run, open, selectedId, theme, onToggle, onSelectWorker, t }: RunBranchProps) {
  return (
    <div className={styles.branch}>
      <button
        type="button"
        className={styles.branchRow}
        style={{ paddingLeft: 8 }}
        data-lane={run.state}
        data-open={open ? 'true' : undefined}
        title={laneTitle(run.state, t) ?? t('orchestrator.selectRun')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onToggle(run.id)}
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        <span className={styles.dot} aria-hidden />
        <span className={styles.branchName}>{run.label}</span>
        <span className={styles.branchCount}>{run.jobs.length}</span>
        <span className={styles.railValue}>{t(LANE_LABEL[run.state])}</span>
      </button>
      <Collapse open={open}>
        {run.jobs.map((job) => (
          <RailRow
            key={job.id}
            job={job}
            depth={1}
            selected={job.id === selectedId}
            theme={theme}
            onSelect={onSelectWorker}
            t={t}
          />
        ))}
      </Collapse>
    </div>
  )
}

type PlannerTabProps = {
  group: PlannerGroup
  selected: boolean
  theme: Theme
  shells: OrchestratorShell[]
  onSelect: (key: string) => void
  t: TFunction
}

function PlannerTab({ group, selected, theme, shells, onSelect, t }: PlannerTabProps) {
  const name = group.label ?? t('orchestrator.noPlanner')
  // Liveness of the planner's own terminal - never derived from its jobs, which can all be
  // finished (or there may be none at all) while the terminal itself is still very much connected.
  const terminalAlive = useTerminalsStore((state) =>
    group.id !== null ? (state.byPtyId[group.id]?.alive ?? false) : false,
  )
  const { count, live } = plannerTabActivity(group.jobs.length, shells, group.id, terminalAlive)
  const title = group.label
    ? live
      ? group.agent
        ? t('orchestrator.plannerTitle', { label: group.label, agent: group.agent })
        : group.label
      : t('orchestrator.plannerGone')
    : t('orchestrator.noPlannerTitle')
  const alert = selected ? null : attentionOf(group.counts)

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={styles.tab}
      data-state={group.state}
      data-live={live ? 'true' : 'false'}
      data-selected={selected ? 'true' : undefined}
      title={title}
      aria-label={title}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onSelect(plannerKey(group))}
    >
      <AgentGlyph agent={group.agent} theme={theme} size={13} className={styles.glyph} />
      <span className={styles.dot} aria-hidden />
      <span className={styles.tabName}>{name}</span>
      {alert ? (
        <span className={styles.tabAlert} data-lane={alert.lane}>
          {t(ATTENTION_LABEL[alert.lane], { count: alert.count })}
        </span>
      ) : count > 0 ? (
        <span className={styles.tabCount}>{count}</span>
      ) : null}
    </button>
  )
}

type ShellGroupNodeProps = {
  node: GraphNode
  attachment: ShellAttachment
  count: number
  bind: BindNode
  t: TFunction
}

/** Laid out like `RunNode`, but never clickable — it groups shells, it does not steer anything. */
function ShellGroupNode({ node, attachment, count, bind, t }: ShellGroupNodeProps) {
  return (
    <article
      ref={(element) => bind(node.id, element)}
      className={styles.shellGroup}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-attachment={attachment}
    >
      <div className={styles.shellGroupCard}>
        <span className={styles.runEyebrow}>
          <span className={styles.dot} aria-hidden />
          <span className={styles.runKind}>{t('orchestrator.shellsEyebrow')}</span>
        </span>
        <span className={styles.runLabel}>
          {t(
            attachment === 'attached'
              ? 'orchestrator.shellsLabel'
              : 'orchestrator.shellsOrphanLabel',
          )}
        </span>
        <span className={styles.runFoot}>
          <span>
            {t(count === 1 ? 'orchestrator.shellCount' : 'orchestrator.shellCountPlural', { count })}
          </span>
        </span>
      </div>
    </article>
  )
}

export type OrchestratorPaneProps = {
  projectId: string
  terminal: Terminal
}

export const OrchestratorPane = memo(function OrchestratorPane({
  projectId,
  terminal,
}: OrchestratorPaneProps) {
  const t = useT()
  const theme = useProjectsStore((state) => state.preferences.uiTheme)
  const closePane = useProjectsStore((state) => state.closePane)
  const projects = useProjectsStore((state) => state.projects)
  const openTerminalWorkspace = useProjectsStore((state) => state.openTerminalWorkspace)
  const createTerminal = useProjectsStore((state) => state.createTerminal)
  const deleteTerminal = useProjectsStore((state) => state.deleteTerminal)
  const setActiveTab = useProjectsStore((state) => state.setActiveTab)
  const pushToast = useUiStore((state) => state.pushToast)
  const openModal = useUiStore((state) => state.openModal_)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const setInspectorPty = useUiStore((state) => state.setInspectorPty)
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot>(EMPTY)
  const quotaWarnings = useOrchestratorQuotaWarnings()
  const [selectedPlanner, setSelectedPlanner] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<{ kind: 'worker' | 'shell'; id: string } | null>(
    null,
  )
  const [openRuns, setOpenRuns] = useState<Record<string, boolean>>({})
  const [summaryOpen, setSummaryOpen] = useState(true)
  const [answering, setAnswering] = useState<ReadonlySet<string>>(() => new Set())
  const [diffText, setDiffText] = useState<Record<string, string>>({})
  const [diffLoading, setDiffLoading] = useState<ReadonlySet<string>>(() => new Set())
  const [shellBusy, setShellBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [heights, setHeights] = useState<NodeHeights>({})
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW)
  const [panning, setPanning] = useState(false)
  // The pane has no terminal theme of its own yet; every other host of XTermView derives it this
  // way (see TerminalPane/index.tsx:138-140).
  const terminalTheme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const storedShortcuts = useProjectsStore((state) => state.preferences.orchestratorShortcuts)
  const shortcuts = useMemo(() => resolveShortcuts(storedShortcuts, t), [storedShortcuts, t])
  // A planner is an agent terminal, so adding one is opening one. The shared new-terminal modal
  // does the asking, narrowed to the agents that can actually drive the orchestrator.
  const addPlanner = useCallback(() => {
    openModal('newTerminal', {
      projectId,
      only: ['claude'],
      titleKey: 'term.newPlannerTitle',
    })
  }, [openModal, projectId])

  const nodes = useRef(new Map<string, HTMLElement>())
  const board = useRef<HTMLDivElement | null>(null)
  const world = useRef<HTMLDivElement | null>(null)
  const pan = useRef<{ id: number; x: number; y: number } | null>(null)
  const moved = useRef(false)
  // Elapsed time on a running job is derived from its start, so the pane has to re-render on its
  // own between events: a worker that reports nothing for a minute would otherwise look frozen.
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    void orchestratorJobs()
      .then((initial) => {
        if (!cancelled) setSnapshot(initial)
      })
      .catch(() => {})

    void listenOrchestratorJobs((next) => {
      if (!cancelled) setSnapshot(next)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const busy = snapshot.running > 0
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setTick((value) => value + 1), LIVE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [busy])

  const subagentNodes = useAgentCanvasStore((s) => s.nodes)

  // Planners live app-wide (one per agent terminal, anywhere), so the snapshot is global — but the
  // board is opened from one project, and a planner from another project is noise here, not signal.
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])
  const projectPtyIds = useMemo(() => {
    const ids = new Set<string>()
    if (!project) return ids
    for (const term of project.terminals) {
      for (const tab of term.tabs) if (tab.ptyId) ids.add(tab.ptyId)
    }
    return ids
  }, [project])

  const jobs = useMemo(() => {
    const native = nativeSubagentJobs(subagentNodes)
    const all = native.length > 0 ? [...snapshot.jobs, ...native] : snapshot.jobs
    return all.filter((job) =>
      job.plannerId
        ? projectPtyIds.has(job.plannerId)
        : project?.defaultCwd
          ? job.cwd.startsWith(project.defaultCwd)
          : true,
    )
  }, [snapshot.jobs, subagentNodes, projectPtyIds, project])
  // Every planner id these jobs could point at, so a shortcut's visibility can react to that one
  // terminal dying without depending on the whole `byPtyId` map (which changes for any terminal).
  const jobPlannerIds = useMemo(
    () => [...new Set(jobs.map((job) => job.plannerId).filter((id): id is string => id !== null))],
    [jobs],
  )
  // A sorted, joined string is a stable primitive: Zustand's default equality (Object.is) skips a
  // re-render unless the set of alive planners actually changed, unlike a freshly-built array/Set.
  const alivePlannerKey = useTerminalsStore((state) =>
    jobPlannerIds
      .filter((id) => state.byPtyId[id]?.alive)
      .sort()
      .join(','),
  )
  const alivePlannerIds = useMemo(
    () => new Set(alivePlannerKey ? alivePlannerKey.split(',') : []),
    [alivePlannerKey],
  )
  const planners = useMemo(
    () => snapshot.planners.filter((p) => projectPtyIds.has(p.id)),
    [snapshot.planners, projectPtyIds],
  )
  const groups = useMemo(() => groupPlanners(jobs, planners), [jobs, planners])
  const activeGroup =
    groups.find((group) => plannerKey(group) === selectedPlanner) ?? groups[0] ?? null
  const groupJobs = useMemo(() => activeGroup?.jobs ?? [], [activeGroup])
  const runs = useMemo(() => activeGroup?.runs ?? [], [activeGroup])
  const plannerId = activeGroup?.id ?? null
  // The planners of every group on screen right now — a shell of one of these stays under its own
  // tab; anything else (no planner, or one whose terminal closed) falls back to this project's cwd.
  const livePlannerIds = useMemo(
    () => new Set(groups.map((group) => group.id).filter((id): id is string => id !== null)),
    [groups],
  )
  const shells = useMemo(
    () =>
      shellsForBoard(snapshot.shells, {
        activePlannerId: plannerId,
        livePlannerIds,
        projectCwd: project?.defaultCwd ?? null,
      }),
    [snapshot.shells, plannerId, livePlannerIds, project],
  )
  const shellById = useMemo(() => new Map(shells.map((shell) => [shell.id, shell])), [shells])
  const layoutShells = useMemo<LayoutShell[]>(
    () => shells.map((shell) => ({ id: shell.id, attachment: shell.attachment, status: shell.status })),
    [shells],
  )
  // Only the first image a worker's report mentions gets promoted to its own canvas card — enough
  // to surface "the thing it made" without the layout having to reflow siblings for 2nd/3rd images.
  // See `splitPromotedMedia`, shared with the inspector's own media strip.
  const promotedMediaByJobId = useMemo(() => {
    const map = new Map<string, MediaItem>()
    for (const job of groupJobs) {
      const report = job.summary.trim()
      if (!report) continue
      const { promoted } = splitPromotedMedia(extractMediaItems(report))
      if (promoted) map.set(job.id, promoted)
    }
    return map
  }, [groupJobs])
  const mediaByNodeId = useMemo(() => {
    const map = new Map<string, MediaItem>()
    for (const [jobId, item] of promotedMediaByJobId) map.set(mediaNodeId(jobId), item)
    return map
  }, [promotedMediaByJobId])
  const graph = useMemo(
    () => layoutPlannerBoard(runs, heights, plannerId, promotedMediaByJobId, layoutShells),
    [runs, heights, plannerId, promotedMediaByJobId, layoutShells],
  )
  const jobById = useMemo(() => new Map(groupJobs.map((job) => [job.id, job])), [groupJobs])
  const plannerTarget = useMemo(
    () => (plannerId ? findPlannerTerminal(projects, plannerId) : null),
    [projects, plannerId],
  )
  const inspectorTarget = useMemo((): InspectorTarget | null => {
    if (!inspecting) return null
    if (inspecting.kind === 'worker') {
      const job = jobById.get(inspecting.id)
      return job ? { kind: 'worker', job } : null
    }
    const shell = shellById.get(inspecting.id)
    return shell ? { kind: 'shell', shell } : null
  }, [inspecting, jobById, shellById])
  const selectedWorkerId = inspecting?.kind === 'worker' ? inspecting.id : null

  useEffect(() => {
    if (!inspecting) return
    if (inspecting.kind === 'worker' && !jobById.has(inspecting.id)) setInspecting(null)
    if (inspecting.kind === 'shell' && !shellById.has(inspecting.id)) setInspecting(null)
  }, [jobById, shellById, inspecting])

  // Cards grow as a worker reports more, so the column has to be re-measured; the hover bar and
  // the inspector panel are overlays and never change a node's own box.
  useLayoutEffect(() => {
    setHeights((prev) => {
      let next: Record<string, number> | null = null
      for (const [id, element] of nodes.current) {
        const measured = element.offsetHeight
        if (measured > 0 && prev[id] !== measured) {
          next = next ?? { ...prev }
          next[id] = measured
        }
      }
      return next ?? prev
    })
  }, [groupJobs, plannerId, shells])

  const viewport = useCallback(() => {
    const element = board.current
    return { width: element?.clientWidth ?? 0, height: element?.clientHeight ?? 0 }
  }, [])

  const graphRef = useRef(graph)
  graphRef.current = graph

  const fit = useCallback(() => {
    setView(fitView(graphRef.current, viewport()))
  }, [viewport])

  const activeKey = activeGroup ? plannerKey(activeGroup) : null
  useLayoutEffect(() => {
    moved.current = false
  }, [activeKey])

  useLayoutEffect(() => {
    if (moved.current) return
    fit()
  }, [activeKey, graph.width, graph.height, fit])

  const hasBoard = graph.width > 0
  useEffect(() => {
    const element = board.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      moved.current = true
      setView((prev) =>
        zoomAt(prev, Math.exp(-event.deltaY / 400), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      )
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [hasBoard])

  useEffect(() => {
    const element = board.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!moved.current) fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasBoard, fit])

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.target !== board.current && event.target !== world.current) return
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    moved.current = true
    setPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = pan.current
    if (!active || active.id !== event.pointerId) return
    const dx = event.clientX - active.x
    const dy = event.clientY - active.y
    active.x = event.clientX
    active.y = event.clientY
    setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id !== event.pointerId) return
    pan.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const zoomBy = (factor: number) => {
    const size = viewport()
    moved.current = true
    setView((prev) => zoomAt(prev, factor, { x: size.width / 2, y: size.height / 2 }))
  }

  const counts = activeGroup?.counts ?? emptyCounts()
  const total = groupJobs.length
  const donePercent = total === 0 ? 0 : Math.round((counts.finished / total) * 100)
  const needsAttention = useMemo(() => {
    const rows: AttentionRow[] = []
    for (const group of groups) {
      if (plannerKey(group) === activeKey) continue
      const attention = attentionOf(group.counts)
      if (attention) rows.push({ group, attention })
    }
    return rows.sort(attentionFirst)
  }, [groups, activeKey])
  const interruptedAll = jobs.filter((job) => job.status === 'interrupted').length
  const blockedAll = jobs.filter((job) => job.status === 'blocked').length

  const openPlanner = (key: string) => {
    setSelectedPlanner(key)
    setInspecting(null)
  }

  const bind = useCallback<BindNode>((id, element) => {
    if (element) nodes.current.set(id, element)
    else nodes.current.delete(id)
  }, [])

  // Selecting a worker from the rail always opens the panel, which covers the board — so there is
  // nothing to gain from panning the canvas underneath it first.
  const reveal = (id: string) => {
    setInspecting({ kind: 'worker', id })
  }

  const revealRun = (id: string) => {
    const tree = graphRef.current.trees.find((entry) => entry.id === id)
    if (!tree) return
    const size = viewport()
    moved.current = true
    setView((prev) => focusView(tree, prev, size))
  }

  const toggleRun = (id: string) => {
    const run = runs.find((entry) => entry.id === id)
    if (run) setOpenRuns((prev) => ({ ...prev, [id]: !(prev[id] ?? opensByDefault(run)) }))
    revealRun(id)
  }

  const revealPlanner = plannerTarget
    ? () => {
        openTerminalWorkspace(plannerTarget.projectId, plannerTarget.terminalId)
        setActiveTerminal(plannerTarget.projectId, plannerTarget.terminalId)
        requestPaneFocus(plannerTarget.terminalId)
        setActiveView('workspace')
      }
    : null

  const answer = async (jobId: string, decision: OrchestratorDecision) => {
    if (answering.has(jobId)) return
    setAnswering((prev) => new Set(prev).add(jobId))
    try {
      await orchestratorAnswer(jobId, decision)
    } catch (error) {
      pushToast({
        title: t('orchestrator.answerFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setAnswering((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  const stopJob = async (jobId: string) => {
    try {
      await orchestratorCancelJob(jobId)
    } catch (error) {
      pushToast({
        title: t('orchestrator.stopFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Whether the terminal this job's agent runs in is still alive, independent of the job's own
  // status — a finished worker's planner can easily have moved on to another terminal by then.
  // Backed by the subscribed `alivePlannerIds` above, so a planner dying while its jobs sit idle
  // still hides its shortcuts instead of leaving stale buttons pointed at a dead terminal.
  const plannerAliveFor = (job: OrchestratorJob): boolean =>
    job.plannerId ? alivePlannerIds.has(job.plannerId) : false

  // The instruction is typed into the planner's input and left there: the person edits it and sends.
  const sendShortcut = async (job: OrchestratorJob, shortcut: OrchestratorShortcut) => {
    const target = job.plannerId ? findPlannerTerminal(projects, job.plannerId) : null
    const alive = plannerAliveFor(job)
    if (!target || !alive || !job.plannerId) {
      pushToast({ title: t('orchestrator.noPlannerForShortcuts'), body: '' })
      return
    }
    setInspecting(null)
    openTerminalWorkspace(target.projectId, target.terminalId)
    setActiveTerminal(target.projectId, target.terminalId)
    requestPaneFocus(target.terminalId)
    setActiveView('workspace')
    await writePtyChunked(job.plannerId, renderShortcut(shortcut, job, project?.defaultCwd ?? null), true)
  }

  const loadDiff = async (jobId: string) => {
    if (diffText[jobId] !== undefined || diffLoading.has(jobId)) return
    setDiffLoading((prev) => new Set(prev).add(jobId))
    try {
      const text = await orchestratorJobDiff(jobId)
      setDiffText((prev) => ({ ...prev, [jobId]: text }))
    } catch (error) {
      pushToast({
        title: t('orchestrator.diffFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDiffLoading((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  // The check spans every project, not just the one on screen: a shell's live terminal tab can sit
  // in a project other than this one, and reusing it there beats opening a second view of the same
  // PTY here. Only when no live view exists anywhere does cleanup/creation stay scoped to this
  // project, since that is the board the person is acting from.
  const planShellTerminal = (shell: OrchestratorShell) => {
    const isLive = (ptyId: string) => useTerminalsStore.getState().byPtyId[ptyId]?.alive ?? false
    for (const proj of projects) {
      const candidate = shellTerminalPlan(proj.terminals, shell, isLive)
      if (candidate.action === 'reuse') return { plan: candidate, ownerProjectId: proj.id }
    }
    return { plan: shellTerminalPlan(project?.terminals ?? [], shell, isLive), ownerProjectId: projectId }
  }

  // A view onto the running shell, never a new one — except a tab left over from a view that
  // outlived its PTY (e.g. across an app restart) never comes back on its own (`viewGone` in
  // useXtermSession), so it is dropped in favor of a fresh tab rather than reused dead. Opening the
  // terminal tab always closes the panel first — one process, one view.
  const openShellTerminal = (shell: OrchestratorShell) => {
    setInspecting(null)
    const { plan, ownerProjectId } = planShellTerminal(shell)
    let terminalId: string
    if (plan.action === 'reuse') {
      terminalId = plan.terminalId
      setActiveTab(ownerProjectId, terminalId, plan.tabId)
      // An existing terminal may live in a workspace tab other than the one on screen, so it has to
      // be brought into view. A freshly created one must NOT go through here: `createTerminal`
      // already put it in the project's container, and opening a workspace tab for it as well would
      // show the same shell twice — once in the grid the person is looking at, once in a new tab.
      openTerminalWorkspace(ownerProjectId, terminalId)
    } else {
      if (plan.staleTerminalId) deleteTerminal(ownerProjectId, plan.staleTerminalId)
      terminalId = createTerminal(ownerProjectId, {
        name: shell.name,
        cwd: shell.cwd,
        firstTab: { type: 'shell', cwd: shell.cwd, ptyId: shell.ptyId },
      }).id
    }
    setActiveTerminal(ownerProjectId, terminalId)
    requestPaneFocus(terminalId)
    setActiveView('workspace')
  }

  const controlShell = async (shell: OrchestratorShell, control: ShellControl) => {
    if (control === 'openTerminal') {
      openShellTerminal(shell)
      return
    }
    if (shellBusy.has(shell.id)) return
    setShellBusy((prev) => new Set(prev).add(shell.id))
    try {
      if (control === 'stop') await orchestratorShellStop(shell.id)
      else if (control === 'remove') await orchestratorShellRemove(shell.id)
      else await orchestratorShellRestart(shell.id)
    } catch (error) {
      pushToast({
        title: t('orchestrator.shell.failed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setShellBusy((prev) => {
        const next = new Set(prev)
        next.delete(shell.id)
        return next
      })
    }
  }

  // Respects the one-process-one-view rule: a shell already attached to a live terminal in any
  // project activates that tab instead of opening the panel, so a detached shell whose view sits
  // outside the project on screen is still found instead of getting a second, duplicate view.
  const openShellInspector = (shell: OrchestratorShell) => {
    const { plan } = planShellTerminal(shell)
    if (plan.action === 'reuse') {
      openShellTerminal(shell)
      return
    }
    // Claimed here rather than in the panel: a child's effect runs before its parent's, so the
    // terminal inside the panel would ask whether it is on screen before the panel could answer —
    // and open without the shell's scrollback. The panel re-asserts it and clears it on close.
    setInspectorPty(shell.ptyId)
    setInspecting({ kind: 'shell', id: shell.id })
  }

  return (
    <section className={styles.pane}>
      <header className={styles.head}>
        <div className={styles.headLeft}>
          <span className={styles.iconWrap}>
            <Network size={16} />
          </span>
          <span className={styles.title}>{t('orchestrator.title')}</span>
        </div>
        <div className={styles.headRight}>
          <div className={styles.counts}>
            {quotaWarnings.map((warning) => (
              <span
                key={warning.agent}
                className={styles.countAlert}
                title={t('orchestrator.quotaWarningTitle', { agent: warning.agent, pct: warning.pct })}
              >
                {t('orchestrator.quotaWarning', {
                  agent: warning.agent,
                  pct: warning.pct,
                  resets: warning.resetsAt ? formatReset(warning.resetsAt, t('orchestrator.quotaResetsNow')) : '—',
                })}
              </span>
            ))}
            {blockedAll > 0 && (
              <span
                className={styles.countAlert}
                data-lane="blocked"
                title={t('orchestrator.blockedTitle')}
              >
                {t('orchestrator.runBlocked', { count: blockedAll })}
              </span>
            )}
            {interruptedAll > 0 && (
              <span
                className={styles.countAlert}
                data-lane="interrupted"
                title={t('orchestrator.interruptedTitle')}
              >
                {t('orchestrator.runInterrupted', { count: interruptedAll })}
              </span>
            )}
            <span>{t('orchestrator.running', { count: String(snapshot.running) })}</span>
            <span>{t('orchestrator.queued', { count: String(snapshot.queued) })}</span>
            <span>{t('orchestrator.limit', { count: String(snapshot.concurrencyLimit) })}</span>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.action} ${styles.danger}`}
              title={t('common.close')}
              aria-label={t('common.close')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => closePane(projectId, terminal.id)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </header>

      {groups.length === 0 && shells.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.empty}>
            <p>{t('orchestrator.emptyTitle')}</p>
            <small>{t('orchestrator.emptyBody')}</small>
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.tabs} role="tablist" aria-label={t('orchestrator.plannersLabel')}>
            {groups.map((group) => (
              <PlannerTab
                key={plannerKey(group)}
                group={group}
                selected={plannerKey(group) === activeKey}
                theme={theme}
                shells={snapshot.shells}
                onSelect={openPlanner}
                t={t}
              />
            ))}
            <button
              type="button"
              className={styles.addPlanner}
              title={t('orchestrator.addPlannerTitle')}
              aria-label={t('orchestrator.addPlannerTitle')}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={addPlanner}
            >
              <Plus size={13} />
            </button>
          </div>

          <div className={styles.split}>
            <div className={styles.canvas}>
              <div
                ref={board}
                className={styles.board}
                data-panning={panning ? 'true' : undefined}
                style={{
                  backgroundSize: `${DOT_SPACING * view.scale}px ${DOT_SPACING * view.scale}px`,
                  backgroundPosition: `${view.x}px ${view.y}px`,
                }}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
              >
                {runs.length === 0 && shells.length === 0 ? (
                  <div className={styles.blank}>{t('orchestrator.emptyPlanner')}</div>
                ) : (
                  <div
                    ref={world}
                    className={styles.world}
                    style={{
                      width: graph.width,
                      height: graph.height,
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    }}
                  >
                    <svg className={styles.edges} width={graph.width} height={graph.height} aria-hidden>
                      {graph.edges.map((edge) => (
                        <path
                          key={edge.id}
                          className={styles.edge}
                          data-lane={edge.lane}
                          data-selected={edge.to === selectedWorkerId ? 'true' : undefined}
                          d={edge.d}
                        />
                      ))}
                    </svg>

                    {graph.edges.map((edge) =>
                      edge.note ? (
                        <span
                          key={`${edge.id}-note`}
                          className={styles.edgeNote}
                          data-verdict={edge.note.verdict}
                          style={{ left: edge.note.x, top: edge.note.y }}
                        >
                          {t(
                            edge.note.verdict === 'ignored'
                              ? 'orchestrator.routingIgnored'
                              : 'orchestrator.routingChosen',
                            {
                              agent: edge.note.agent,
                              window: edge.note.window,
                              used: String(edge.note.used),
                            },
                          )}
                        </span>
                      ) : null,
                    )}

                    {graph.planner && activeGroup && (
                      <PlannerNode
                        group={activeGroup}
                        node={graph.planner}
                        theme={theme}
                        onReveal={revealPlanner}
                        bind={bind}
                        t={t}
                      />
                    )}

                    {graph.roots.map((node, index) => (
                      <RunNode
                        key={rootNodeId(runs[index].id)}
                        run={runs[index]}
                        node={node}
                        onClear={() => setInspecting(null)}
                        bind={bind}
                        t={t}
                      />
                    ))}

                    {graph.workers.map((node) => {
                      const job = jobById.get(node.id)
                      if (!job) return null
                      return (
                        <WorkerNode
                          key={node.id}
                          job={job}
                          node={node}
                          selected={inspecting?.kind === 'worker' && inspecting.id === node.id}
                          answering={answering.has(node.id)}
                          theme={theme}
                          shortcuts={plannerAliveFor(job) ? shortcuts : []}
                          onSelect={(id) => setInspecting({ kind: 'worker', id })}
                          onAnswer={(id, decision) => void answer(id, decision)}
                          onStop={(id) => void stopJob(id)}
                          onShortcut={(job, shortcut) => void sendShortcut(job, shortcut)}
                          bind={bind}
                          t={t}
                        />
                      )
                    })}

                    {graph.media.map((node) => {
                      const item = mediaByNodeId.get(node.id)
                      if (!item) return null
                      return <MediaCardNode key={node.id} node={node} item={item} bind={bind} />
                    })}

                    {graph.shellGroups.map((node) => (
                      <ShellGroupNode
                        key={node.id}
                        node={node}
                        attachment={node.id.endsWith('detached') ? 'detached' : 'attached'}
                        count={
                          shells.filter((shell) =>
                            node.id.endsWith('detached')
                              ? shell.attachment === 'detached'
                              : shell.attachment === 'attached',
                          ).length
                        }
                        bind={bind}
                        t={t}
                      />
                    ))}

                    {graph.shells.map((node) => {
                      const shell = shellById.get(node.id)
                      if (!shell) return null
                      return (
                        <ShellNode
                          key={node.id}
                          shell={shell}
                          node={node}
                          selected={inspecting?.kind === 'shell' && inspecting.id === shell.id}
                          busy={shellBusy.has(shell.id)}
                          onOpen={openShellInspector}
                          onControl={(target, control) => void controlShell(target, control)}
                          bind={bind}
                          t={t}
                        />
                      )
                    })}
                  </div>
                )}

                <div className={styles.hint}>
                  <span>{t('orchestrator.canvasHint')}</span>
                  <span>{t('orchestrator.forestHint')}</span>
                </div>

                <div className={styles.zoomCtl}>
                  <button
                    type="button"
                    className={styles.zoomBtn}
                    title={t('orchestrator.zoomOut')}
                    aria-label={t('orchestrator.zoomOut')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => zoomBy(1 / ZOOM_STEP)}
                  >
                    <Minus size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.zoomBtn}
                    title={t('orchestrator.zoomFitTitle')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={fit}
                  >
                    {t('orchestrator.zoomFit')}
                  </button>
                  <span className={styles.zoomValue}>
                    {t('orchestrator.percent', { value: Math.round(view.scale * 100) })}
                  </span>
                  <button
                    type="button"
                    className={styles.zoomBtn}
                    title={t('orchestrator.zoomIn')}
                    aria-label={t('orchestrator.zoomIn')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => zoomBy(ZOOM_STEP)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            </div>

            <aside className={styles.rail} data-collapsed={summaryOpen ? undefined : 'true'}>
              <button
                type="button"
                className={styles.railHead}
                title={t(summaryOpen ? 'orchestrator.summaryCollapse' : 'orchestrator.summaryExpand')}
                aria-expanded={summaryOpen}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setSummaryOpen((open) => !open)}
              >
                <span className={styles.railHeadChevron} aria-hidden>
                  {summaryOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </span>
                <span className={styles.railHeadLabel}>{t('orchestrator.summary')}</span>
                <span className={styles.railHeadName}>
                  {activeGroup?.label ?? t('orchestrator.noPlanner')}
                </span>
              </button>
              <div className={styles.railScroll} hidden={!summaryOpen}>
                <div className={styles.railSection}>
                  <div className={styles.headline}>
                    <b>{counts.finished}</b>
                    <span>{t('orchestrator.finishedHeadline', { total })}</span>
                    <u>{t('orchestrator.percent', { value: donePercent })}</u>
                  </div>
                  <div className={styles.kvList}>
                    {RUN_LANE_ORDER.map((lane) => (
                      <div
                        key={lane}
                        className={styles.kv}
                        data-lane={lane}
                        data-off={counts[lane] === 0 ? 'true' : undefined}
                      >
                        <em aria-hidden />
                        <span>{t(LANE_LABEL[lane])}</span>
                        <b>{counts[lane]}</b>
                      </div>
                    ))}
                    <div className={styles.kv} data-lane="slots">
                      <em aria-hidden />
                      <span>{t('orchestrator.slots')}</span>
                      <b>{`${snapshot.running}/${snapshot.concurrencyLimit}`}</b>
                    </div>
                  </div>
                </div>

                <div className={styles.railSection} data-tree="true">
                  <div className={styles.railLabel}>
                    <span>{t('orchestrator.runsLabel')}</span>
                    <span className={styles.laneCount}>{runs.length}</span>
                  </div>
                  {runs.length === 0 && (
                    <p className={styles.railEmpty}>{t('orchestrator.noWorkers')}</p>
                  )}
                  {runs.map((run) => (
                    <RunBranch
                      key={run.id}
                      run={run}
                      open={openRuns[run.id] ?? opensByDefault(run)}
                      selectedId={selectedWorkerId}
                      theme={theme}
                      onToggle={toggleRun}
                      onSelectWorker={reveal}
                      t={t}
                    />
                  ))}
                </div>

                {needsAttention.length > 0 && (
                  <div className={styles.railSection}>
                    <div className={styles.railLabel}>
                      <span>{t('orchestrator.attentionLabel')}</span>
                    </div>
                    {needsAttention.map(({ group, attention }) => (
                      <button
                        key={plannerKey(group)}
                        type="button"
                        className={styles.attention}
                        title={laneTitle(attention.lane, t)}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => openPlanner(plannerKey(group))}
                      >
                        <AgentGlyph agent={group.agent} theme={theme} size={12} className={styles.glyph} />
                        <span className={styles.attentionName}>
                          {group.label ?? t('orchestrator.noPlanner')}
                        </span>
                        <span className={styles.attentionValue} data-lane={attention.lane}>
                          {t(ATTENTION_LABEL[attention.lane], { count: attention.count })}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}

      {inspectorTarget && (
        <OrchestratorInspector
          target={inspectorTarget}
          projectId={projectId}
          theme={theme}
          terminalTheme={terminalTheme}
          diffText={diffText[inspectorTarget.kind === 'worker' ? inspectorTarget.job.id : '']}
          diffLoading={diffLoading.has(
            inspectorTarget.kind === 'worker' ? inspectorTarget.job.id : '',
          )}
          shortcuts={shortcuts}
          plannerAlive={inspectorTarget.kind === 'worker' ? plannerAliveFor(inspectorTarget.job) : true}
          shellBusy={
            inspectorTarget.kind === 'shell' ? shellBusy.has(inspectorTarget.shell.id) : false
          }
          canStopJob={inspectorTarget.kind === 'worker' && canStop(inspectorTarget.job)}
          onClose={() => setInspecting(null)}
          onLoadDiff={(jobId) => void loadDiff(jobId)}
          onStopJob={(jobId) => void stopJob(jobId)}
          onShortcut={(job, shortcut) => void sendShortcut(job, shortcut)}
          onShellControl={(shell, control) => void controlShell(shell, control)}
          t={t}
        />
      )}
    </section>
  )
})
