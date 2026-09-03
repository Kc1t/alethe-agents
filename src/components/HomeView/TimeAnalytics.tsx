import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { flushActivityTracker } from '../../lib/activityTracker'
import { intlLocale, type MessageKey,useT } from '../../lib/i18n'
import { type ActivitySummary,getActivitySummary } from '../../lib/tauri'
import type { AgentType } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { AgentIcon } from '../icons/AgentIcons'
import styles from './HomeView.module.css'

type Range = 'today' | '7d' | '30d' | 'all'
const RANGE_KEYS: Record<Range, MessageKey> = {
  today: 'time.range.today',
  '7d': 'time.range.7d',
  '30d': 'time.range.30d',
  all: 'time.range.all',
}

function datesFor(range: Range): string[] {
  if (range === 'all') return []
  const count = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const dates: string[] = []
  const cursor = new Date()
  cursor.setHours(12, 0, 0, 0)
  for (let index = 0; index < count; index++) {
    const year = cursor.getFullYear()
    const month = String(cursor.getMonth() + 1).padStart(2, '0')
    const day = String(cursor.getDate()).padStart(2, '0')
    dates.push(`${year}-${month}-${day}`)
    cursor.setDate(cursor.getDate() - 1)
  }
  return dates
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

export function TimeAnalytics() {
  const t = useT()
  const language = useProjectsStore((state) => state.preferences.language)
  const theme = useProjectsStore((state) => state.preferences.uiTheme)
  const projects = useProjectsStore((state) => state.projects)
  const [range, setRange] = useState<Range>('today')
  const [summary, setSummary] = useState<ActivitySummary | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      await flushActivityTracker()
      setSummary(await getActivitySummary(datesFor(range)))
    } catch {
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )
  const projectRows = useMemo(
    () =>
      Object.entries(summary?.projects ?? {})
        .sort(([, a], [, b]) => b.activeMs + b.agentSumMs - (a.activeMs + a.agentSumMs))
        .slice(0, 5),
    [summary],
  )
  const agentRows = useMemo(
    () => Object.entries(summary?.agents ?? {}).sort(([, a], [, b]) => b.workingMs - a.workingMs),
    [summary],
  )
  const totals = summary?.totals
  const inactive = Math.max(0, (totals?.appOpenMs ?? 0) - (totals?.agentWallMs ?? 0))

  return (
    <div className={styles.timeAnalytics}>
      <div className={styles.timeAnalyticsHead}>
        <div>
          <div className={styles.timeAnalyticsTitle}>{t('time.title')}</div>
          <div className={styles.timeAnalyticsSub}>{t('time.subtitle')}</div>
        </div>
        <div className={styles.timeRange}>
          {(['today', '7d', '30d', 'all'] as Range[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`${styles.timeRangeOption} ${range === value ? styles.timeRangeActive : ''}`}
              aria-pressed={range === value}
              onClick={() => setRange(value)}
            >
              {t(RANGE_KEYS[value])}
            </button>
          ))}
          <button
            className={styles.timeRefresh}
            type="button"
            onClick={() => void load()}
            title={t('time.refresh')}
            aria-label={t('time.refresh')}
          >
            <RefreshCw size={12} className={loading ? styles.iconBtnSpin : undefined} />
          </button>
        </div>
      </div>

      <div className={styles.timeSummaryGrid} aria-busy={loading}>
        <Metric
          label={t('time.active')}
          value={duration(totals?.userActiveMs ?? 0)}
          detail={t('time.focusedDetail', { value: duration(totals?.appFocusedMs ?? 0) })}
        />
        <Metric
          label={t('time.agentWall')}
          value={duration(totals?.agentWallMs ?? 0)}
          detail={t('time.agentSumDetail', { value: duration(totals?.agentSumMs ?? 0) })}
        />
        <Metric
          label={t('time.background')}
          value={duration(totals?.agentBackgroundMs ?? 0)}
          detail={t('time.parallelDetail', {
            value: duration(totals?.parallelMs ?? 0),
            peak: totals?.peakConcurrent ?? 0,
          })}
        />
        <Metric
          label={t('time.idle')}
          value={duration(totals?.userIdleMs ?? 0)}
          detail={t('time.noAgentDetail', { value: duration(inactive) })}
        />
      </div>

      <div className={styles.timeBreakdowns}>
        <div>
          <div className={styles.timeBreakdownTitle}>{t('time.byAgent')}</div>
          <div className={styles.timeRows}>
            {agentRows.length ? (
              agentRows.map(([agent, value]) => (
                <div className={styles.timeRow} key={agent}>
                  <span className={styles.timeRowName}>
                    <AgentIcon type={agent as AgentType} size={13} theme={theme} />
                    {agent}
                  </span>
                  <span>{duration(value.workingMs)}</span>
                  <small>
                    {t('time.backgroundShort', { value: duration(value.backgroundMs) })}
                  </small>
                </div>
              ))
            ) : (
              <div className={styles.timeEmpty}>{t('time.empty')}</div>
            )}
          </div>
        </div>
        <div>
          <div className={styles.timeBreakdownTitle}>{t('time.byProject')}</div>
          <div className={styles.timeRows}>
            {projectRows.length ? (
              projectRows.map(([projectId, value]) => (
                <div className={styles.timeRow} key={projectId}>
                  <span className={styles.timeRowName}>
                    {projectNames.get(projectId) ??
                      (projectId === '__agent_canvas__'
                        ? 'Agent Canvas'
                        : projectId === '__unassigned__'
                          ? t('time.unassigned')
                          : projectId)}
                  </span>
                  <span>{duration(value.activeMs + value.agentWallMs)}</span>
                  <small>
                    {t('time.projectDetail', {
                      focus: duration(value.activeMs),
                      agents: duration(value.agentSumMs),
                    })}
                  </small>
                </div>
              ))
            ) : (
              <div className={styles.timeEmpty}>{t('time.empty')}</div>
            )}
          </div>
        </div>
      </div>
      <div className={styles.timeFoot}>
        {t('time.localNote', {
          locale: new Intl.DateTimeFormat(intlLocale(language)).resolvedOptions().timeZone,
        })}
      </div>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={styles.timeMetric}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}
