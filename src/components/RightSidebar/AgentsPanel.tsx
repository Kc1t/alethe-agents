import { Bot, Check, Maximize2, Square, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useFocusedPlannerPtyId } from '../../hooks/useAgentsSidebarAutoOpen'
import { COST_POLL_MS } from '../../lib/agentCanvasConfig'
import { fmtUsd } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import { nativeSubagentJobs } from '../../lib/orchestratorSubagents'
import {
  listenOrchestratorJobs,
  orchestratorAnswer,
  orchestratorCancel,
  orchestratorJobs,
  type OrchestratorDecision,
  type OrchestratorJob,
  type OrchestratorJobStatus,
  type OrchestratorSnapshot,
} from '../../lib/tauri/orchestrator'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useNodeCostStore } from '../../stores/nodeCostStore'
import { selectActiveProject, useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './AgentsPanel.module.css'

const LIVE_TICK_MS = 1_000

/** Statuses whose worker still holds a slot and can be cancelled. */
const LIVE_STATUSES: ReadonlySet<OrchestratorJobStatus> = new Set(['queued', 'running', 'blocked'])

/** Attention first, settled last; order is stable within a status. */
const STATUS_ORDER: Record<OrchestratorJobStatus, number> = {
  blocked: 0,
  running: 1,
  queued: 2,
  interrupted: 3,
  failed: 4,
  done: 5,
  cancelled: 6,
  released: 7,
}

function formatElapsed(seconds: number | null): string | null {
  if (seconds === null) return null
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

function jobTitle(job: OrchestratorJob): string {
  const firstLine = job.spec
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return firstLine || job.runLabel || job.id
}

export function AgentsPanel() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot | null>(null)
  const plannerPtyId = useFocusedPlannerPtyId()
  const subagentNodes = useAgentCanvasStore((s) => s.nodes)
  const nodeCosts = useNodeCostStore((s) => s.byNodeId)
  const activeProject = useProjectsStore(selectActiveProject)
  const createOrchestratorPane = useProjectsStore((s) => s.createOrchestratorPane)
  const setActiveView = useUiStore((s) => s.setActiveView)
  // Elapsed time on a live job is derived from its start, so the panel re-renders on its own
  // between snapshot events.
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

  const busy = (snapshot?.running ?? 0) > 0 || subagentNodes.some((n) => n.status === 'running')
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setTick((value) => value + 1), LIVE_TICK_MS)
    return () => window.clearInterval(timer)
  }, [busy])

  // Native subagents report cost through their transcripts, which the store polls for.
  useEffect(() => {
    if (!subagentNodes.some((node) => node.transcriptPath)) return
    const refresh = () => void useNodeCostStore.getState().refresh(subagentNodes)
    refresh()
    const timer = window.setInterval(refresh, COST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [subagentNodes])

  const jobs = useMemo(() => {
    const native = nativeSubagentJobs(subagentNodes, nodeCosts)
    const all = native.length > 0 ? [...(snapshot?.jobs ?? []), ...native] : (snapshot?.jobs ?? [])
    const scoped = plannerPtyId ? all.filter((job) => job.plannerId === plannerPtyId) : all
    return [...scoped].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  }, [snapshot, subagentNodes, nodeCosts, plannerPtyId])

  const openBoard = () => {
    if (!activeProject) return
    createOrchestratorPane(
      activeProject.id,
      activeProject.defaultCwd ?? activeProject.terminals[0]?.cwd ?? '',
    )
    setActiveView('workspace')
  }

  const runningCount = jobs.filter((job) => job.status === 'running').length

  return (
    <section className={styles.panel} aria-label={t('agentsPanel.title')}>
      <header className={styles.header}>
        <Bot size={15} />
        <span className={styles.headerTitle}>{t('agentsPanel.title')}</span>
        <span className={styles.scope}>
          {plannerPtyId ? t('agentsPanel.scopeFocused') : t('agentsPanel.scopeAll')}
        </span>
        {runningCount > 0 ? (
          <span className={styles.running}>{t('orchestrator.running', { count: runningCount })}</span>
        ) : null}
        <span className={styles.headerSpacer} />
        <button
          type="button"
          className={styles.iconAction}
          onClick={openBoard}
          title={t('agentsPanel.expand')}
          aria-label={t('agentsPanel.expand')}
        >
          <Maximize2 size={13} />
        </button>
      </header>
      {jobs.length === 0 ? (
        <div className={styles.empty}>
          <Bot size={20} />
          <strong>{t('agentsPanel.emptyTitle')}</strong>
          <span>{t('agentsPanel.emptyBody')}</span>
        </div>
      ) : (
        <div className={styles.list}>
          {jobs.map((job) => (
            <AgentJobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  )
}

function AgentJobCard({ job }: { job: OrchestratorJob }) {
  const t = useT()
  const pushToast = useUiStore((s) => s.pushToast)
  const [acting, setActing] = useState(false)
  const live = LIVE_STATUSES.has(job.status)
  const elapsed = formatElapsed(job.seconds)
  const chip = [job.agent, job.model, job.effort].filter(Boolean).join(' · ')
  const cost = job.costUsd !== null ? fmtUsd(job.costUsd) : null

  const cancel = async () => {
    setActing(true)
    try {
      await orchestratorCancel(job.id)
    } catch {
      pushToast({ title: t('orchestrator.stopFailed'), body: '' })
    } finally {
      setActing(false)
    }
  }

  const answer = (decision: OrchestratorDecision) => async () => {
    setActing(true)
    try {
      await orchestratorAnswer(job.id, decision)
    } catch {
      pushToast({ title: t('orchestrator.answerFailed'), body: '' })
    } finally {
      setActing(false)
    }
  }

  return (
    <article className={styles.card} data-status={job.status}>
      <span className={styles.dot} aria-hidden />
      <div className={styles.cardBody}>
        <div className={styles.cardTop}>
          <span className={styles.cardTitle} title={job.spec}>
            {jobTitle(job)}
          </span>
          {elapsed && <span className={styles.elapsed}>{elapsed}</span>}
        </div>
        <div className={styles.cardMeta}>
          <span className={styles.chip} title={chip}>
            {chip}
          </span>
          <span className={styles.statusLabel}>{t(`orchestrator.status.${job.status}`)}</span>
          {cost && (
            <span className={styles.cost} title={t('orchestrator.costTitle')}>
              {cost}
            </span>
          )}
        </div>
        {job.pendingApproval && !job.native ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.answerButton}
              onClick={answer('accept')}
              disabled={acting}
              title={t('orchestrator.answerAcceptTitle')}
            >
              <Check size={11} />
              {t('orchestrator.answerAccept')}
            </button>
            <button
              type="button"
              className={styles.answerButton}
              onClick={answer('decline')}
              disabled={acting}
              title={t('orchestrator.answerDeclineTitle')}
            >
              <X size={11} />
              {t('orchestrator.answerDecline')}
            </button>
          </div>
        ) : null}
      </div>
      {live && !job.native ? (
        <div className={styles.cardActions}>
          <button
            type="button"
            className={styles.iconAction}
            onClick={cancel}
            disabled={acting}
            title={t('orchestrator.menuStop')}
            aria-label={t('orchestrator.menuStop')}
          >
            <Square size={11} />
          </button>
        </div>
      ) : null}
    </article>
  )
}
