import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Cpu,
  GitBranch,
  Minus,
  Plus,
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

import { type MessageKey, type TFunction, useT } from '../../lib/i18n'
import {
  DOT_SPACING,
  fitView,
  focusView,
  type GraphNode,
  layoutPlannerBoard,
  type NodeHeights,
  rootNodeId,
  type ViewTransform,
  zoomAt,
} from '../../lib/orchestratorGraph'
import {
  groupPlanners,
  LANE_OF,
  type OrchestratorRun,
  type PlannerGroup,
  RUN_LANE_ORDER,
  type RunLane,
} from '../../lib/orchestratorRuns'
import {
  listenOrchestratorJobs,
  type OrchestratorJob,
  orchestratorJobs,
  orchestratorMessage,
  type OrchestratorSnapshot,
} from '../../lib/tauri'
import { parseAgentType, type Project, type Terminal, type Theme } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { Collapse } from '../ui/Collapse'
import styles from './OrchestratorPane.module.css'

const EMPTY: OrchestratorSnapshot = {
  jobs: [],
  planners: [],
  running: 0,
  queued: 0,
  concurrencyLimit: 0,
}

const LIVE_TICK_MS = 1_000

const ZOOM_STEP = 1.2

const IDENTITY_VIEW: ViewTransform = { scale: 1, x: 0, y: 0 }

const LANE_LABEL: Record<RunLane, `orchestrator.lane.${RunLane}`> = {
  running: 'orchestrator.lane.running',
  queued: 'orchestrator.lane.queued',
  interrupted: 'orchestrator.lane.interrupted',
  failed: 'orchestrator.lane.failed',
  finished: 'orchestrator.lane.finished',
}

// A planner id is a terminal id, never empty, so the empty string can stand for the group of jobs
// that carry no planner at all.
function plannerKey(group: PlannerGroup): string {
  return group.id ?? ''
}

function formatElapsed(seconds: number | null): string | null {
  if (seconds === null) return null
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

function formatTokens(total: number | undefined): string | null {
  if (!total) return null
  if (total < 1000) return `${total}`
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
}

function contextShare(job: OrchestratorJob): number | null {
  const used = job.tokens?.total?.totalTokens
  const window = job.tokens?.modelContextWindow
  if (!used || !window) return null
  return Math.min(100, Math.round((used / window) * 100))
}

/** A worker's conclusion is the last thing it says: its opening line is narration, not a result. */
function latestLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

type MessageMode = 'steer' | 'resume' | 'next'

const MODE_PLACEHOLDER: Record<MessageMode, MessageKey> = {
  steer: 'orchestrator.steerPlaceholder',
  resume: 'orchestrator.resumePlaceholder',
  next: 'orchestrator.sendPlaceholder',
}

const MODE_HINT: Record<MessageMode, MessageKey> = {
  steer: 'orchestrator.steerHint',
  resume: 'orchestrator.resumeHint',
  next: 'orchestrator.sendHint',
}

const MODE_LABEL: Record<MessageMode, MessageKey> = {
  steer: 'orchestrator.modeSteer',
  resume: 'orchestrator.modeResume',
  next: 'orchestrator.modeNext',
}

// Released and cancelled workers are gone for good. An interrupted one is not: `alethe_send`
// re-queues a worker whose process died and resumes its thread, so a message is how it comes back.
function canMessage(job: OrchestratorJob): boolean {
  if (job.status === 'released' || job.status === 'cancelled') return false
  if (job.status === 'interrupted') return job.threadId !== null
  return true
}

function messageMode(job: OrchestratorJob): MessageMode {
  if (job.status === 'running') return 'steer'
  if (job.status === 'interrupted') return 'resume'
  return 'next'
}

function needsYou(group: PlannerGroup): number {
  return group.counts.failed + group.counts.interrupted
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

type AgentGlyphProps = {
  agent: string | null
  theme: Theme
  size?: number
  title?: string
}

function AgentGlyph({ agent, theme, size = 15, title }: AgentGlyphProps) {
  const type = parseAgentType(agent)
  return (
    <span className={styles.glyph} title={title} aria-hidden>
      {type ? <AgentIcon type={type} size={size} theme={theme} /> : <Cpu size={size} />}
    </span>
  )
}

type BindNode = (id: string, element: HTMLElement | null) => void

type WorkerNodeProps = {
  job: OrchestratorJob
  node: GraphNode
  selected: boolean
  theme: Theme
  onSelect: (id: string) => void
  onMessage: (id: string) => void
  bind: BindNode
  t: TFunction
}

function WorkerNode({
  job,
  node,
  selected,
  theme,
  onSelect,
  onMessage,
  bind,
  t,
}: WorkerNodeProps) {
  const share = contextShare(job)
  const tokens = formatTokens(job.tokens?.total?.totalTokens)
  const elapsed = formatElapsed(job.seconds)
  const live = latestLine(job.summary) || latestLine(job.spec)
  const plan = job.plan.filter((step) => step.trim().length > 0)
  const report = job.summary.trim()

  return (
    <article
      ref={(element) => bind(job.id, element)}
      className={styles.worker}
      style={{ left: node.x, top: node.y, width: node.width }}
      data-status={job.status}
      data-lane={LANE_OF[job.status]}
      data-selected={selected ? 'true' : undefined}
    >
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
          />
          <span className={styles.dot} aria-hidden />
          <span className={styles.workerId}>{job.id}</span>
          {elapsed && <span className={styles.workerElapsed}>{elapsed}</span>}
        </span>

        {live && <span className={styles.workerLive}>{live}</span>}

        <span className={styles.meta}>
          <span
            className={styles.metaStatus}
            title={job.status === 'interrupted' ? t('orchestrator.interruptedTitle') : undefined}
          >
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

      {job.status === 'failed' && job.outcome && (
        <div className={styles.errBar}>
          <span className={styles.errText} title={job.outcome}>
            {job.outcome}
          </span>
        </div>
      )}

      {selected && (
        <div className={styles.detail}>
          {plan.length > 0 && (
            <>
              <div className={styles.detailLabel}>{t('orchestrator.planLabel')}</div>
              <ul className={styles.plan}>
                {plan.map((step, index) => (
                  <li key={`${job.id}-plan-${index}`}>{step}</li>
                ))}
              </ul>
            </>
          )}
          <div className={styles.detailLabel}>{t('orchestrator.summaryLabel')}</div>
          <p className={styles.report}>{report || t('orchestrator.noReport')}</p>
          {canMessage(job) && (
            <div className={styles.detailActions}>
              <button
                type="button"
                className={styles.action}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => onMessage(job.id)}
              >
                {t('orchestrator.messageAction')}
              </button>
            </div>
          )}
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
          <span
            className={styles.runState}
            title={run.state === 'interrupted' ? t('orchestrator.interruptedTitle') : undefined}
          >
            {t(LANE_LABEL[run.state])}
          </span>
        </span>
        <span className={styles.runLabel}>{run.label}</span>
        <span className={styles.runFoot}>
          <span>{t('orchestrator.workerCount', { count: total })}</span>
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
  return (
    <button
      type="button"
      className={styles.railRow}
      style={{ paddingLeft: 8 + depth * 14 }}
      data-status={job.status}
      data-selected={selected ? 'true' : undefined}
      title={t('orchestrator.selectWorker')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onSelect(job.id)}
    >
      <span className={styles.dot} aria-hidden />
      <AgentGlyph agent={job.agent} theme={theme} size={12} />
      <span className={styles.railName}>{job.id}</span>
      <span className={styles.railValue}>{elapsed ?? t(LANE_LABEL[LANE_OF[job.status]])}</span>
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
        title={t('orchestrator.selectRun')}
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
  onSelect: (key: string) => void
  t: TFunction
}

function PlannerTab({ group, selected, theme, onSelect, t }: PlannerTabProps) {
  const name = group.label ?? t('orchestrator.noPlanner')
  const title = group.label
    ? group.agent
      ? t('orchestrator.plannerTitle', { label: group.label, agent: group.agent })
      : group.label
    : t('orchestrator.noPlannerTitle')
  const alert = !selected && needsYou(group) > 0

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={styles.tab}
      data-state={group.state}
      data-selected={selected ? 'true' : undefined}
      title={title}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => onSelect(plannerKey(group))}
    >
      <AgentGlyph agent={group.agent} theme={theme} size={13} />
      <span className={styles.dot} aria-hidden />
      <span className={styles.tabName}>{name}</span>
      {alert ? (
        <span className={styles.tabAlert}>
          {group.counts.failed > 0
            ? t('orchestrator.runFailed', { count: group.counts.failed })
            : t('orchestrator.runInterrupted', { count: group.counts.interrupted })}
        </span>
      ) : (
        <span className={styles.tabCount}>{group.jobs.length}</span>
      )}
    </button>
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
  const pushToast = useUiStore((state) => state.pushToast)
  const openModal = useUiStore((state) => state.openModal_)
  const setActiveTerminal = useUiStore((state) => state.setActiveTerminal)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const requestPaneFocus = useUiStore((state) => state.requestPaneFocus)
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot>(EMPTY)
  const [selectedPlanner, setSelectedPlanner] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openRuns, setOpenRuns] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [heights, setHeights] = useState<NodeHeights>({})
  const [view, setView] = useState<ViewTransform>(IDENTITY_VIEW)
  const [panning, setPanning] = useState(false)
  // A planner is an agent terminal, so adding one is opening one. The shared new-terminal modal
  // does the asking, narrowed to the agents that can actually drive the orchestrator.
  const addPlanner = useCallback(() => {
    openModal('newTerminal', {
      projectId,
      only: ['claude'],
      titleKey: 'orchestrator.addPlannerTitle',
    })
  }, [openModal, projectId])

  const nodes = useRef(new Map<string, HTMLElement>())
  const composer = useRef<HTMLInputElement | null>(null)
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

  const jobs = snapshot.jobs
  const planners = snapshot.planners
  const groups = useMemo(() => groupPlanners(jobs, planners), [jobs, planners])
  const activeGroup =
    groups.find((group) => plannerKey(group) === selectedPlanner) ?? groups[0] ?? null
  const groupJobs = useMemo(() => activeGroup?.jobs ?? [], [activeGroup])
  const runs = useMemo(() => activeGroup?.runs ?? [], [activeGroup])
  const plannerId = activeGroup?.id ?? null
  const graph = useMemo(
    () => layoutPlannerBoard(runs, heights, plannerId),
    [runs, heights, plannerId],
  )
  const jobById = useMemo(() => new Map(groupJobs.map((job) => [job.id, job])), [groupJobs])
  const selected = selectedId ? (jobById.get(selectedId) ?? null) : null
  const plannerTarget = useMemo(
    () => (plannerId ? findPlannerTerminal(projects, plannerId) : null),
    [projects, plannerId],
  )

  useEffect(() => {
    if (selectedId && !jobById.has(selectedId)) setSelectedId(null)
  }, [jobById, selectedId])

  // Cards grow when a worker is opened or reports more, so the column has to be re-measured.
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
  }, [groupJobs, plannerId, selectedId])

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

  const counts = activeGroup?.counts ?? {
    running: 0,
    queued: 0,
    interrupted: 0,
    failed: 0,
    finished: 0,
  }
  const total = groupJobs.length
  const donePercent = total === 0 ? 0 : Math.round((counts.finished / total) * 100)
  const needsAttention = groups.filter(
    (group) => plannerKey(group) !== activeKey && needsYou(group) > 0,
  )
  const interruptedAll = jobs.filter((job) => job.status === 'interrupted').length

  const openPlanner = (key: string) => {
    setSelectedPlanner(key)
    setSelectedId(null)
  }

  const bind = useCallback<BindNode>((id, element) => {
    if (element) nodes.current.set(id, element)
    else nodes.current.delete(id)
  }, [])

  const reveal = (id: string) => {
    setSelectedId(id)
    const node = graphRef.current.workers.find((entry) => entry.id === id)
    if (!node) return
    const size = viewport()
    moved.current = true
    setView((prev) => focusView(node, prev, size))
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

  const focusComposer = (id: string) => {
    setSelectedId(id)
    composer.current?.focus()
  }

  const mode: MessageMode = selected ? messageMode(selected) : 'next'
  const canSend = selected !== null && canMessage(selected)

  const send = async () => {
    const message = draft.trim()
    if (!selected || !message || sending || !canSend) return
    setSending(true)
    try {
      await orchestratorMessage(selected.id, message, mode === 'steer')
      setDraft('')
    } catch (error) {
      pushToast({
        title: t('orchestrator.sendFailed'),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <section className={styles.pane}>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('orchestrator.title')}</h2>
        <div className={styles.counts}>
          {interruptedAll > 0 && (
            <span className={styles.countAlert} title={t('orchestrator.interruptedTitle')}>
              {t('orchestrator.runInterrupted', { count: interruptedAll })}
            </span>
          )}
          <span>{t('orchestrator.running', { count: String(snapshot.running) })}</span>
          <span>{t('orchestrator.queued', { count: String(snapshot.queued) })}</span>
          <span>{t('orchestrator.limit', { count: String(snapshot.concurrencyLimit) })}</span>
        </div>
        <button
          type="button"
          className={styles.close}
          title={t('common.close')}
          aria-label={t('common.close')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => closePane(projectId, terminal.id)}
        >
          <X size={14} />
        </button>
      </header>

      {groups.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('orchestrator.emptyTitle')}</p>
          <small>{t('orchestrator.emptyBody')}</small>
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
                {runs.length === 0 ? (
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
                          data-selected={edge.to === selectedId ? 'true' : undefined}
                          d={edge.d}
                        />
                      ))}
                    </svg>

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
                        onClear={() => setSelectedId(null)}
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
                          selected={node.id === selectedId}
                          theme={theme}
                          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
                          onMessage={focusComposer}
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

              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault()
                  void send()
                }}
              >
                {selected ? (
                  <span className={styles.composerTarget} data-status={selected.status}>
                    <span className={styles.dot} aria-hidden />
                    <AgentGlyph agent={selected.agent} theme={theme} size={13} />
                    <span className={styles.composerId}>
                      {t('orchestrator.composeTo', { id: selected.id })}
                    </span>
                  </span>
                ) : (
                  <span className={styles.composerTarget}>
                    <span className={styles.composerId} data-idle="true">
                      {t('orchestrator.composeNoTarget')}
                    </span>
                  </span>
                )}
                <input
                  ref={composer}
                  className={styles.composerInput}
                  value={draft}
                  disabled={!canSend || sending}
                  placeholder={t(MODE_PLACEHOLDER[mode])}
                  onChange={(event) => setDraft(event.target.value)}
                  onPointerDown={(event) => event.stopPropagation()}
                />
                {canSend && mode === 'resume' && (
                  <span className={styles.composerNote}>{t('orchestrator.resumeNote')}</span>
                )}
                {canSend && (
                  <span className={styles.composerMode} data-mode={mode}>
                    {t(MODE_LABEL[mode])}
                  </span>
                )}
                <button
                  type="submit"
                  className={styles.composerSend}
                  disabled={!canSend || sending || draft.trim().length === 0}
                  title={t(MODE_HINT[mode])}
                  aria-label={t(MODE_HINT[mode])}
                >
                  <CornerDownLeft size={12} />
                </button>
              </form>
            </div>

            <aside className={styles.rail}>
              <div className={styles.railHead}>
                <span>{t('orchestrator.summary')}</span>
                <span className={styles.railHeadName}>
                  {activeGroup?.label ?? t('orchestrator.noPlanner')}
                </span>
              </div>
              <div className={styles.railScroll}>
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
                      selectedId={selectedId}
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
                    {needsAttention.map((group) => (
                      <button
                        key={plannerKey(group)}
                        type="button"
                        className={styles.attention}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => openPlanner(plannerKey(group))}
                      >
                        <AgentGlyph agent={group.agent} theme={theme} size={12} />
                        <span className={styles.attentionName}>
                          {group.label ?? t('orchestrator.noPlanner')}
                        </span>
                        <span
                          className={styles.attentionValue}
                          data-lane={group.counts.failed > 0 ? 'failed' : 'interrupted'}
                        >
                          {group.counts.failed > 0
                            ? t('orchestrator.runFailed', { count: group.counts.failed })
                            : t('orchestrator.runInterrupted', {
                                count: group.counts.interrupted,
                              })}
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
    </section>
  )
})
