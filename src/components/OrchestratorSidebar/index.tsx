import { GripVertical, LayoutTemplate, Settings } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'

import { useOrchestratorSnapshot } from '../../hooks/useOrchestratorSnapshot'
import { agentLabel } from '../../lib/agentProviders'
import { fmtTokens, fmtUsd } from '../../lib/costFormat'
import { type MessageKey, type TFunction, useT } from '../../lib/i18n'
import { routingNoteText, ruleOverrideLabels } from '../../lib/orchestratorRouting'
import { LANE_OF } from '../../lib/orchestratorRuns'
import { nativeSubagentJobs } from '../../lib/orchestratorSubagents'
import { moveItem } from '../../lib/reorder'
import {
  orchestratorAnswer,
  orchestratorCancel,
  orchestratorClear,
  type OrchestratorDecision,
  type OrchestratorJob,
  orchestratorJobDiff,
  type OrchestratorJobStatus,
  orchestratorMessage,
  type OrchestratorPendingApproval,
  orchestratorRelease,
  orchestratorReorderQueue,
} from '../../lib/tauri'
import {
  type AgentType,
  ORCHESTRATOR_PLANNER_AGENTS,
  type Project,
  type Theme,
} from '../../lib/types'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { Collapse } from '../ui/Collapse'
import { Dropdown } from '../ui/Dropdown'
import { type SortableDrag, SortableList } from '../ui/SortableList'
import styles from './OrchestratorSidebar.module.css'

const STATUS_LABELS: Record<OrchestratorJobStatus, MessageKey> = {
  queued: 'orchestrator.status.queued',
  running: 'orchestrator.status.running',
  done: 'orchestrator.status.done',
  failed: 'orchestrator.status.failed',
  cancelled: 'orchestrator.status.cancelled',
  released: 'orchestrator.status.released',
  interrupted: 'orchestrator.status.interrupted',
  blocked: 'orchestrator.status.blocked',
}

const OUTCOME_LABELS: Record<string, MessageKey> = {
  failed: 'orchestrator.outcome.failed',
  timeout: 'orchestrator.outcome.timeout',
  interrupted: 'orchestrator.outcome.interrupted',
  'send-failed': 'orchestrator.outcome.sendFailed',
  cancelled: 'orchestrator.outcome.cancelled',
}

const ACTIVE = new Set<OrchestratorJobStatus>(['queued', 'running', 'blocked'])

type PlannerTab = {
  /** The planner's PTY, which is the id its delegations are filed under. */
  id: string
  label: string
  agent: AgentType
  projectId: string
  terminalId: string
  cwd: string
}

// The panel unmounts when another sidebar tab is shown, so the planner it was following has to
// outlive it: coming back, or clicking a worker's own terminal, must not empty the list.
let lastPlannerId: string | null = null

function plannerTabs(projects: readonly Project[]): PlannerTab[] {
  const found: PlannerTab[] = []
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.orchestrationRole !== 'planner' || !tab.ptyId) continue
        found.push({
          id: tab.ptyId,
          label: terminal.tabs.length > 1 ? `${terminal.name} · ${tab.name}` : terminal.name,
          agent: tab.type,
          projectId: project.id,
          terminalId: terminal.id,
          cwd: tab.cwd || terminal.cwd,
        })
      }
    }
  }
  return found
}

function elapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole}s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

function jobPriority(job: OrchestratorJob): number {
  if (job.status === 'blocked') return 0
  if (job.status === 'running') return 1
  if (job.status === 'queued') return 2
  return 3
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function askHeadline(ask: OrchestratorPendingApproval, t: TFunction): string {
  if (ask.kind === 'fileChange') return t('orchestrator.askFileChange')
  if (ask.kind === 'tool') return t('orchestrator.askTool', { tool: ask.tool ?? '' })
  return t('orchestrator.askCommand')
}

/** What the worker is asking for, so an approval is never given without seeing it. */
function askDetail(ask: OrchestratorPendingApproval): string {
  if (ask.command) return ask.command
  const files = ask.files ?? []
  if (files.length > 0) return files.join('\n')
  return ask.reason ?? ''
}

type WorkerRowProps = {
  job: OrchestratorJob
  seconds: number | null
  expanded: boolean
  busy: boolean
  theme: Theme
  /** Present on a worker waiting for a slot among others, which can be dragged up or down. */
  drag?: SortableDrag
  onToggle: () => void
  onAnswer: (decision: OrchestratorDecision) => void
  onStop: () => void
  onRelease: () => void
  /** Reports a failed action; the row itself never throws. */
  onError: (title: MessageKey, error: unknown) => void
  t: TFunction
}

/**
 * One worker, in the board's own vocabulary: a status dot, the agent's glyph, what it was asked to
 * do and how long it has been at it. Everything else stays folded until the row is opened, except a
 * question, which is always in view because the worker is stopped on it.
 */
function WorkerRow({
  job,
  seconds,
  expanded,
  busy,
  theme,
  drag,
  onToggle,
  onAnswer,
  onStop,
  onRelease,
  onError,
  t,
}: WorkerRowProps) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  // null until asked for; the diff is fetched when it is opened, not with every snapshot.
  const [diff, setDiff] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const lane = LANE_OF[job.status]
  const active = ACTIVE.has(job.status)
  const ask = !job.native && job.status === 'blocked' ? job.pendingApproval : null
  const behind = Math.max(0, (job.waitingApprovals ?? 1) - 1)
  const failed = job.status === 'failed' && job.outcome
  const report = job.summary.trim()
  const tier = job.routing?.verdict === 'routed' ? job.routing.tier : undefined
  const moved = Boolean(job.routing?.avoided) || job.routing?.verdict === 'ignored'
  const meta = [agentLabel(job.agent as AgentType), job.model, job.effort].filter(Boolean)
  // What a running worker last said, so the row shows progress without being opened.
  const live = job.status === 'running' && !expanded ? lastLine(report) : ''
  const canStop = !job.native && active
  const canRelease = !job.native && !active && Boolean(job.live)
  const tokens = job.tokens?.total?.totalTokens
  const cost = job.costUsd !== null && job.costUsd !== undefined ? fmtUsd(job.costUsd) : null

  // More work for the worker: it runs as its next turn, on everything it already knows.
  const send = async (event: FormEvent) => {
    event.preventDefault()
    const text = message.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await orchestratorMessage(job.id, text, false)
      setMessage('')
    } catch (error) {
      onError('orchestrator.sendFailed', error)
    } finally {
      setSending(false)
    }
  }

  const toggleDiff = async () => {
    if (diffOpen) {
      setDiffOpen(false)
      return
    }
    setDiffOpen(true)
    setDiff(null)
    try {
      setDiff(await orchestratorJobDiff(job.id))
    } catch (error) {
      setDiffOpen(false)
      onError('orchestrator.diffFailed', error)
    }
  }

  return (
    <article
      className={styles.worker}
      data-status={job.status}
      data-lane={lane}
      data-open={expanded ? 'true' : undefined}
    >
      {drag ? (
        <button
          type="button"
          className={styles.grip}
          {...drag.handleProps}
          title={t('orchestrator.queueDrag')}
          aria-label={t('orchestrator.queueDrag')}
        >
          <GripVertical size={11} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.row}
        onClick={onToggle}
        aria-expanded={expanded}
        title={t(expanded ? 'orchestrator.sidebarHideDetails' : 'orchestrator.sidebarShowDetails')}
      >
        <span className={styles.dot} aria-hidden />
        <span className={styles.glyph} aria-hidden>
          <AgentIcon type={job.agent} size={13} theme={theme} />
        </span>
        <span className={styles.task}>{firstLine(job.spec)}</span>
        <span className={styles.value}>
          {seconds === null ? t(`orchestrator.lane.${lane}`) : elapsed(seconds)}
        </span>
        <span className={styles.meta}>
          {/* The dot and the clock already say a worker is live; only an ended one needs the word. */}
          {active ? null : (
            <span className={styles.metaStatus}>{t(STATUS_LABELS[job.status])}</span>
          )}
          {meta.map((entry) => (
            <span key={entry}>{entry}</span>
          ))}
          {tier ? (
            <span data-moved={moved ? 'true' : undefined}>{t(`orchestrator.tier.${tier}`)}</span>
          ) : null}
          {job.worktree ? <span>{t('orchestrator.isolated')}</span> : null}
          {ruleOverrideLabels(job.overrides, t).map((rule) => (
            <span key={rule} className={styles.metaRule} title={t('orchestrator.ruleTitle')}>
              {rule}
            </span>
          ))}
          {tokens ? <span title={t('orchestrator.tokensTitle')}>{fmtTokens(tokens)}</span> : null}
          {cost ? <span title={t('orchestrator.costTitle')}>{cost}</span> : null}
        </span>
        {live ? <span className={styles.live}>{live}</span> : null}
      </button>

      {ask ? (
        <div className={styles.ask}>
          <div className={styles.askHead}>{t('orchestrator.askLabel')}</div>
          <p className={styles.askWhat}>{askHeadline(ask, t)}</p>
          {askDetail(ask) ? <code className={styles.askCommand}>{askDetail(ask)}</code> : null}
          {ask.reason && ask.reason !== askDetail(ask) ? (
            <p className={styles.askReason}>{ask.reason}</p>
          ) : null}
          {behind > 0 ? (
            <p className={styles.askHint}>{t('orchestrator.askMore', { count: behind })}</p>
          ) : null}
          <div className={styles.askActions}>
            <button
              type="button"
              className={styles.askAction}
              data-decision="accept"
              onClick={() => onAnswer('accept')}
              disabled={busy}
              title={t('orchestrator.answerAcceptTitle')}
            >
              {t('orchestrator.answerAccept')}
            </button>
            <button
              type="button"
              className={styles.askAction}
              onClick={() => onAnswer('acceptForSession')}
              disabled={busy}
              title={t('orchestrator.answerSessionTitle')}
            >
              {t('orchestrator.answerSession')}
            </button>
            <button
              type="button"
              className={styles.askAction}
              data-wide="true"
              onClick={() => onAnswer('decline')}
              disabled={busy}
              title={t('orchestrator.answerDeclineTitle')}
            >
              {t('orchestrator.answerDecline')}
            </button>
          </div>
        </div>
      ) : null}

      {failed ? (
        <div className={styles.errBar} title={report || failed}>
          {OUTCOME_LABELS[failed] ? t(OUTCOME_LABELS[failed]) : failed}
          {lastLine(report) ? ` · ${lastLine(report)}` : ''}
        </div>
      ) : null}

      <Collapse open={expanded}>
        <div className={styles.detail}>
          <div className={styles.detailLabel}>{t('orchestrator.sidebarTaskLabel')}</div>
          <p className={styles.spec}>{job.spec}</p>
          {job.routing ? (
            <>
              <div className={styles.detailLabel}>{t('orchestrator.sidebarRouteLabel')}</div>
              <p className={styles.spec}>{routingNoteText(job.routing, t)}</p>
            </>
          ) : null}
          <div className={styles.detailLabel}>{t('orchestrator.summaryLabel')}</div>
          <pre className={styles.report}>{report || t('orchestrator.noReport')}</pre>
          {diffOpen ? (
            <pre className={styles.report} data-kind="diff">
              {diff === null ? t('orchestrator.diffLoading') : diff || t('orchestrator.noDiff')}
            </pre>
          ) : null}
          {job.native ? null : (
            <form className={styles.composer} onSubmit={(event) => void send(event)}>
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={t('orchestrator.sendPlaceholder')}
                title={t('orchestrator.sendHint')}
                aria-label={t('orchestrator.sendPlaceholder')}
                disabled={sending}
              />
              <button type="submit" className={styles.action} disabled={sending || !message.trim()}>
                {t('orchestrator.messageAction')}
              </button>
            </form>
          )}
          {canStop || canRelease || job.hasDiff ? (
            <div className={styles.detailActions}>
              {job.hasDiff ? (
                <button
                  type="button"
                  className={styles.action}
                  data-on={diffOpen ? 'true' : undefined}
                  onClick={() => void toggleDiff()}
                >
                  {t('orchestrator.hasDiff')}
                </button>
              ) : null}
              {canStop ? (
                <button
                  type="button"
                  className={styles.action}
                  data-tone="danger"
                  onClick={onStop}
                  disabled={busy}
                  title={t('orchestrator.stopTitle')}
                >
                  {t('orchestrator.stopAction')}
                </button>
              ) : null}
              {canRelease ? (
                <button
                  type="button"
                  className={styles.action}
                  onClick={onRelease}
                  disabled={busy}
                  title={t('orchestrator.releaseTitle')}
                >
                  {t('orchestrator.releaseAction')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </Collapse>
    </article>
  )
}

export function OrchestratorSidebar() {
  const t = useT()
  const { snapshot, receivedAt } = useOrchestratorSnapshot()
  const [clock, setClock] = useState(() => Date.now())
  const [picked, setPicked] = useState(lastPlannerId)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const focusedTerminalId = useUiStore((state) => state.focusedTerminalId)
  const activeTerminal = useUiStore((state) => state.activeTerminal)
  const setActiveView = useUiStore((state) => state.setActiveView)
  const openModal = useUiStore((state) => state.openModal_)
  const pushToast = useUiStore((state) => state.pushToast)
  const projects = useProjectsStore((state) => state.projects)
  const activeProjectId = useProjectsStore((state) => state.activeProjectId)
  const createOrchestratorPane = useProjectsStore((state) => state.createOrchestratorPane)
  const openTerminalWorkspace = useProjectsStore((state) => state.openTerminalWorkspace)
  const theme = useProjectsStore(
    (state) => state.preferences.terminalTheme ?? state.preferences.uiTheme,
  )
  const nativeNodes = useAgentCanvasStore((state) => state.nodes)

  const planners = useMemo(() => plannerTabs(projects), [projects])

  // The planner the person is working in, when the terminal in front of them is one.
  const activePlannerId = useMemo(() => {
    const terminalId = focusedTerminalId ?? activeTerminal?.terminalId ?? null
    if (!terminalId) return null
    for (const project of projects) {
      const terminal = project.terminals.find((candidate) => candidate.id === terminalId)
      if (!terminal) continue
      const tab = terminal.tabs.find((candidate) => candidate.id === terminal.activeTabId)
      return tab?.orchestrationRole === 'planner' ? tab.ptyId : null
    }
    return null
  }, [activeTerminal?.terminalId, focusedTerminalId, projects])

  useEffect(() => {
    if (activePlannerId) setPicked(activePlannerId)
  }, [activePlannerId])

  // Moving to a shell or to a worker's terminal keeps the last planner's list in view. With none
  // followed yet, the one with work in flight is the one worth showing.
  const planner =
    planners.find((candidate) => candidate.id === picked) ??
    planners.find((candidate) =>
      snapshot.jobs.some((job) => job.plannerId === candidate.id && ACTIVE.has(job.status)),
    ) ??
    planners[0] ??
    null
  const plannerId = planner?.id ?? null

  useEffect(() => {
    lastPlannerId = plannerId
  }, [plannerId])

  const jobs = useMemo(() => {
    if (!plannerId) return []
    // Native subagents carry no clock of their own: theirs is read off `clock` on every tick.
    void clock
    const native = nativeSubagentJobs(
      nativeNodes.filter((node) => node.plannerId === plannerId),
      {},
      t('orchestrator.subagentsRun'),
    )
    const all = [...snapshot.jobs.filter((job) => job.plannerId === plannerId), ...native]
    // Whatever needs the person comes first, then what is running; finished work goes newest
    // first, so the result just delivered is not buried under older ones.
    return all
      .map((job, index) => ({ job, index }))
      .sort(
        (a, b) =>
          jobPriority(a.job) - jobPriority(b.job) ||
          // Waiting workers keep the order they will start in.
          (a.job.status === 'queued' && b.job.status === 'queued'
            ? (a.job.queuePosition ?? 0) - (b.job.queuePosition ?? 0)
            : b.index - a.index),
      )
      .map((entry) => entry.job)
  }, [clock, nativeNodes, plannerId, snapshot.jobs, t])

  const hasActiveJobs = jobs.some((job) => ACTIVE.has(job.status))

  useEffect(() => {
    if (!hasActiveJobs) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasActiveJobs])

  const counts = useMemo(
    () => ({
      running: jobs.filter((job) => job.status === 'running').length,
      queued: jobs.filter((job) => job.status === 'queued').length,
      blocked: jobs.filter((job) => job.status === 'blocked').length,
    }),
    [jobs],
  )

  const act = async (jobId: string, action: () => Promise<unknown>, failed: MessageKey) => {
    if (busy.has(jobId)) return
    setBusy((prev) => new Set(prev).add(jobId))
    try {
      await action()
    } catch (error) {
      pushToast({
        title: t(failed),
        body: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  const reportError = (title: MessageKey, error: unknown) =>
    pushToast({ title: t(title), body: error instanceof Error ? error.message : String(error) })

  const toggle = (jobId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(jobId)) next.add(jobId)
      return next
    })

  const openSettings = () =>
    openModal('preferences', { category: 'orchestration', target: 'orchestration-routing' })

  const openBoard = () => {
    if (!planner) return
    const project = projects.find((candidate) => candidate.id === planner.projectId)
    if (!project) return
    const existing = project.terminals.find((terminal) => terminal.kind === 'orchestrator')
    const board = existing ?? createOrchestratorPane(project.id, planner.cwd)
    openTerminalWorkspace(project.id, board.id)
    setActiveView('workspace')
  }

  if (!planner) {
    const projectId = activeTerminal?.projectId ?? activeProjectId ?? projects[0]?.id
    return (
      <section className={styles.panel}>
        <div className={styles.empty}>
          <p>{t('orchestrator.sidebarNoPlanner')}</p>
          <small>{t('orchestrator.sidebarNoPlannerBody')}</small>
          <div className={styles.emptyActions}>
            {projectId ? (
              <button
                type="button"
                className={styles.action}
                onClick={() =>
                  openModal('newTerminal', {
                    projectId,
                    only: [...ORCHESTRATOR_PLANNER_AGENTS],
                    titleKey: 'term.newPlannerTitle',
                  })
                }
              >
                {t('orchestrator.sidebarNewPlanner')}
              </button>
            ) : null}
            <button type="button" className={styles.action} onClick={openSettings}>
              {t('orchestrator.sidebarOpenSettings')}
            </button>
          </div>
        </div>
      </section>
    )
  }

  const live = jobs.filter((job) => job.status === 'blocked' || job.status === 'running')
  const queued = jobs.filter((job) => job.status === 'queued')
  const finished = jobs.filter((job) => !ACTIVE.has(job.status))
  // Only Alethe's own workers hold a place in the queue; a planner's native subagents do not.
  const sortable = queued.length > 1 && queued.every((job) => !job.native)

  const reorderQueue = (from: number, to: number) => {
    const ids = moveItem(
      queued.map((job) => job.id),
      from,
      to,
    )
    orchestratorReorderQueue(ids).catch((error: unknown) =>
      pushToast({
        title: t('orchestrator.queueReorderFailed'),
        body: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  // What the planner's delegated work has cost so far. Native subagents are billed to the planner's
  // own session, so they are not part of it.
  const spend = jobs.reduce(
    (total, job) => ({
      tokens: total.tokens + (job.native ? 0 : (job.tokens?.total?.totalTokens ?? 0)),
      cost: total.cost + (job.native ? 0 : (job.costUsd ?? 0)),
    }),
    { tokens: 0, cost: 0 },
  )
  const clearable = finished.filter((job) => !job.native).map((job) => job.id)

  const clearFinished = () => {
    orchestratorClear(clearable).catch((error: unknown) =>
      reportError('orchestrator.clearFailed', error),
    )
  }

  const row = (job: OrchestratorJob, drag?: SortableDrag) => (
    <WorkerRow
      key={job.id}
      job={job}
      seconds={
        job.seconds === null
          ? null
          : job.seconds +
            (!job.native && job.status === 'running' ? Math.max(0, clock - receivedAt) / 1_000 : 0)
      }
      expanded={expanded.has(job.id)}
      busy={busy.has(job.id)}
      theme={theme}
      drag={drag}
      onToggle={() => toggle(job.id)}
      onAnswer={(decision) =>
        void act(job.id, () => orchestratorAnswer(job.id, decision), 'orchestrator.answerFailed')
      }
      onStop={() => void act(job.id, () => orchestratorCancel([job.id]), 'orchestrator.stopFailed')}
      onRelease={() =>
        void act(job.id, () => orchestratorRelease([job.id]), 'orchestrator.releaseFailed')
      }
      onError={reportError}
      t={t}
    />
  )

  return (
    <section className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.glyph} aria-hidden>
          <AgentIcon type={planner.agent} size={14} theme={theme} />
        </span>
        {planners.length > 1 ? (
          <div className={styles.picker}>
            <Dropdown
              value={planner.id}
              options={planners.map((candidate) => ({
                value: candidate.id,
                label: candidate.label,
              }))}
              onChange={setPicked}
              ariaLabel={t('orchestrator.sidebarPlannerPicker')}
            />
          </div>
        ) : (
          <span className={styles.title} title={planner.label}>
            {planner.label}
          </span>
        )}
        <button
          type="button"
          className={styles.utility}
          onClick={openSettings}
          title={t('orchestrator.sidebarOpenSettings')}
          aria-label={t('orchestrator.sidebarOpenSettings')}
        >
          <Settings size={14} />
        </button>
        <button
          type="button"
          className={styles.utility}
          onClick={openBoard}
          title={t('orchestrator.openBoard')}
          aria-label={t('orchestrator.openBoard')}
        >
          <LayoutTemplate size={14} />
        </button>
      </header>

      {jobs.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('orchestrator.emptyTitle')}</p>
          <small>{t('orchestrator.sidebarEmptyBody')}</small>
        </div>
      ) : (
        <div className={styles.scroll}>
          <div className={styles.counts}>
            {counts.blocked > 0 ? (
              <span className={styles.countAlert}>
                {t('orchestrator.runBlocked', { count: counts.blocked })}
              </span>
            ) : null}
            {counts.running > 0 ? (
              <span>{t('orchestrator.running', { count: counts.running })}</span>
            ) : null}
            {counts.queued > 0 ? (
              <span>{t('orchestrator.queued', { count: counts.queued })}</span>
            ) : null}
            {hasActiveJobs ? null : <span>{t('orchestrator.sidebarIdle')}</span>}
            {spend.tokens > 0 ? (
              <span title={t('orchestrator.sidebarSpendTitle')}>
                {spend.cost > 0
                  ? `${fmtTokens(spend.tokens)} · ${fmtUsd(spend.cost)}`
                  : fmtTokens(spend.tokens)}
              </span>
            ) : null}
            <span className={styles.limit}>
              {t('orchestrator.limit', { count: snapshot.concurrencyLimit })}
            </span>
          </div>
          {live.map((job) => row(job))}
          {queued.length > 0 && live.length > 0 ? (
            <div className={styles.sectionLabel}>{t('orchestrator.queueLabel')}</div>
          ) : null}
          {sortable ? (
            <SortableList
              items={queued}
              getId={(job) => job.id}
              onReorder={reorderQueue}
              renderItem={(job, _, drag) => row(job, drag)}
            />
          ) : (
            queued.map((job) => row(job))
          )}
          {finished.length > 0 ? (
            <div className={styles.sectionLabel}>
              <span>{t('orchestrator.lane.finished')}</span>
              {clearable.length > 0 ? (
                <button
                  type="button"
                  onClick={clearFinished}
                  title={t('orchestrator.clearFinishedTitle')}
                >
                  {t('orchestrator.clearFinished')}
                </button>
              ) : null}
            </div>
          ) : null}
          {finished.map((job) => row(job))}
        </div>
      )}
    </section>
  )
}
