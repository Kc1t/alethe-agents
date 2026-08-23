import { CornerDownLeft, GitBranch, X } from 'lucide-react'
import { memo, useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  listenOrchestratorJobs,
  type OrchestratorJob,
  orchestratorJobs,
  orchestratorMessage,
  type OrchestratorSnapshot,
} from '../../lib/tauri'
import { type Terminal } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './OrchestratorPane.module.css'

const EMPTY: OrchestratorSnapshot = { jobs: [], running: 0, queued: 0, concurrencyLimit: 0 }

const LIVE_TICK_MS = 1_000

/** Whatever is still moving comes first; finished work is history and can wait to the right. */
const STATUS_RANK: Record<OrchestratorJob['status'], number> = {
  running: 0,
  queued: 1,
  failed: 2,
  done: 3,
  cancelled: 3,
  released: 3,
}

function forDisplay(jobs: OrchestratorJob[]): OrchestratorJob[] {
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((a, b) => STATUS_RANK[a.job.status] - STATUS_RANK[b.job.status] || b.index - a.index)
    .map((entry) => entry.job)
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null) return '—'
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

function formatTokens(total: number | undefined): string | null {
  if (!total) return null
  if (total < 1000) return `${total}`
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
}

function WorkerInput({ job }: { job: OrchestratorJob }) {
  const t = useT()
  const pushToast = useUiStore((state) => state.pushToast)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const live = job.status === 'running'
  const gone = job.status === 'released' || job.status === 'cancelled'
  if (gone) return null

  const submit = async () => {
    const message = draft.trim()
    if (!message || sending) return
    setSending(true)
    try {
      await orchestratorMessage(job.id, message, live)
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
    <form
      className={styles.compose}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <input
        className={styles.composeInput}
        value={draft}
        disabled={sending}
        placeholder={live ? t('orchestrator.steerPlaceholder') : t('orchestrator.sendPlaceholder')}
        onChange={(event) => setDraft(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <button
        type="submit"
        className={styles.composeSend}
        disabled={sending || draft.trim().length === 0}
        title={live ? t('orchestrator.steerHint') : t('orchestrator.sendHint')}
        aria-label={live ? t('orchestrator.steerHint') : t('orchestrator.sendHint')}
      >
        <CornerDownLeft size={12} />
      </button>
    </form>
  )
}

function JobCard({ job }: { job: OrchestratorJob }) {
  const t = useT()
  const tokens = formatTokens(job.tokens?.total?.totalTokens)
  const detail = job.summary.trim()
  return (
    <article className={styles.card} data-status={job.status}>
      <header className={styles.cardHead}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.jobId}>{job.id}</span>
        <span className={styles.elapsed}>{formatElapsed(job.seconds)}</span>
      </header>
      <p className={styles.status}>
        {t(`orchestrator.status.${job.status}`)}
        {job.outcome && job.outcome !== 'succeeded' ? ` · ${job.outcome}` : ''}
      </p>
      <p className={styles.spec} title={job.spec}>
        {job.spec}
      </p>
      {job.plan.length > 0 && (
        <ul className={styles.plan}>
          {job.plan.map((step, index) => (
            <li key={`${job.id}-plan-${index}`}>{step}</li>
          ))}
        </ul>
      )}
      {detail && <p className={styles.summary}>{detail}</p>}
      <footer className={styles.cardFoot}>
        {tokens && <span title={t('orchestrator.tokensTitle')}>{tokens}</span>}
        {job.worktree && (
          <span className={styles.worktree} title={job.worktree}>
            <GitBranch size={11} aria-hidden />
            {t('orchestrator.isolated')}
          </span>
        )}
        {job.hasDiff && <span>{t('orchestrator.hasDiff')}</span>}
      </footer>
      <WorkerInput job={job} />
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
  const closePane = useProjectsStore((state) => state.closePane)
  const [snapshot, setSnapshot] = useState<OrchestratorSnapshot>(EMPTY)
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

  return (
    <section className={styles.pane}>
      <header className={styles.head}>
        <h2 className={styles.title}>{t('orchestrator.title')}</h2>
        <div className={styles.counts}>
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
      {snapshot.jobs.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('orchestrator.emptyTitle')}</p>
          <small>{t('orchestrator.emptyBody')}</small>
        </div>
      ) : (
        <div className={styles.board}>
          {forDisplay(snapshot.jobs).map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}
    </section>
  )
})
