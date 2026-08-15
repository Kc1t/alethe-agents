import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { intlLocale, useT } from '../../lib/i18n'
import { getCachedActivity } from '../../lib/activityCache'
import { useProjectsStore } from '../../stores/projectsStore'
import type { ActivityDay } from '../../lib/tauri'
import styles from './HomeView.module.css'

const DAYS_TOTAL = 91 // 13 semanas × 7 dias

/** Gera matriz semanas[col][weekday] alinhada por dia da semana. */
function buildGrid(days: ActivityDay[]): (ActivityDay | null)[][] {
  if (days.length === 0) return []
  const firstDate = new Date(`${days[0].date}T00:00:00Z`)
  const firstWeekday = firstDate.getUTCDay()

  const cells: (ActivityDay | null)[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  cells.push(...days)

  const cols: (ActivityDay | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    cols.push(cells.slice(i, i + 7))
  }
  return cols
}

function intensityClass(count: number, max: number): string {
  if (count === 0 || max === 0) return styles.cell0
  const ratio = count / max
  if (ratio < 0.25) return styles.cell1
  if (ratio < 0.5) return styles.cell2
  if (ratio < 0.75) return styles.cell3
  return styles.cell4
}

function formatDateBR(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function totalAndDelta(days: ActivityDay[]): { total: number; deltaPct: number | null } {
  if (days.length < 14) return { total: days.reduce((s, d) => s + d.count, 0), deltaPct: null }
  const halfPoint = days.length - 7
  const recent = days.slice(halfPoint).reduce((s, d) => s + d.count, 0)
  const prev = days.slice(halfPoint - 7, halfPoint).reduce((s, d) => s + d.count, 0)
  const total = days.reduce((s, d) => s + d.count, 0)
  if (prev === 0) return { total, deltaPct: recent > 0 ? 100 : 0 }
  return { total, deltaPct: ((recent - prev) / prev) * 100 }
}

                                                                                       
export function computeStreak(days: ActivityDay[]): number {
  let i = days.length - 1
  while (i >= 0 && days[i].count === 0) i--
  let streak = 0
  while (i >= 0 && days[i].count > 0) {
    streak++
    i--
  }
  return streak
}

export function ActivityGraph() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const weekdayLabels = [
    '',
    t('activity.weekdayMon'),
    '',
    t('activity.weekdayWed'),
    '',
    t('activity.weekdayFri'),
    '',
  ]
  const [days, setDays] = useState<ActivityDay[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = async (force = false) => {
    try {
      const data = await getCachedActivity(DAYS_TOTAL, force)
      setDays(data)
    } catch {
      setDays([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const data = await getCachedActivity(DAYS_TOTAL)
        if (!cancelled) setDays(data)
      } catch {
        if (!cancelled) setDays([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const timer = window.setTimeout(() => void run(), 1500)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await load(true)
    } finally {
      setRefreshing(false)
    }
  }

  const cols = useMemo(() => buildGrid(days), [days])
  const max = useMemo(() => days.reduce((m, d) => Math.max(m, d.count), 0), [days])
  const { total, deltaPct } = useMemo(() => totalAndDelta(days), [days])
  const streak = useMemo(() => computeStreak(days), [days])

  const totalFormatted = total.toLocaleString(intlLocale(language))
  const deltaSign = deltaPct === null ? '' : deltaPct >= 0 ? '▲' : '▼'
  const deltaAbs = deltaPct === null ? null : Math.abs(deltaPct).toFixed(0)
  const hasData = !loading && days.length > 0

  return (
    <div className={styles.usageCard}>
      <div className={styles.cardHead}>
        <div className={`${styles.badge} ${styles.badgeActivity}`}>
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <polyline
              points="2,12 5,8 8,10 11,4 14,6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <span className={styles.name}>{t('activity.title')}</span>
        <span className={styles.plan}>{t('activity.range90d')}</span>
        <div className={styles.headRight}>
          {hasData && (
            <span className={styles.live}>
              <span className={styles.liveDot} style={{ background: 'var(--status-working)' }} />
              {t('widget.live')}
            </span>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            onClick={handleRefresh}
            disabled={refreshing}
            title={t('widget.refreshUsage')}
          >
            <RefreshCw size={12} className={refreshing ? styles.iconBtnSpin : undefined} />
          </button>
        </div>
      </div>

      <div className={styles.hero}>
        <div className={styles.heroNumWrap}>
          <span className={styles.heroNum}>{loading ? '—' : totalFormatted}</span>
          <span className={styles.heroDen}>{t('activity.messages')}</span>
        </div>
        {deltaAbs !== null && (
          <span className={styles.timechip}>
            <b>
              {deltaSign} {deltaAbs}%
            </b>
          </span>
        )}
      </div>
      <div className={styles.heroSub}>{t('activity.lastDays')}</div>

      <div className={styles.heatWrap}>
        {loading ? (
          <div className={styles.activityHeatmapLoading}>{t('activity.loading')}</div>
        ) : days.length === 0 ? (
          <div className={styles.activityHeatmapLoading}>{t('activity.noData')}</div>
        ) : (
          <>
            <div className={styles.activityHeatmap}>
              <div className={styles.activityWeekdays}>
                {weekdayLabels.map((label, i) => (
                  <span key={i}>{label}</span>
                ))}
              </div>
              <div className={styles.activityCols}>
                {cols.map((col, ci) => (
                  <div key={ci} className={styles.activityCol}>
                    {col.map((day, ri) =>
                      day ? (
                        <div
                          key={ri}
                          className={`${styles.activityCell} ${intensityClass(day.count, max)}`}
                          title={t(
                            day.count === 1 ? 'activity.tooltipOne' : 'activity.tooltipMany',
                            {
                              count: day.count,
                              date: formatDateBR(day.date),
                            },
                          )}
                        />
                      ) : (
                        <div key={ri} className={`${styles.activityCell} ${styles.cellEmpty}`} />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
            <span className={styles.activityLegendGroup}>
              <span className={styles.activityLegend}>{t('activity.less')}</span>
              <span className={`${styles.activityLegendCell} ${styles.cell0}`} />
              <span className={`${styles.activityLegendCell} ${styles.cell1}`} />
              <span className={`${styles.activityLegendCell} ${styles.cell2}`} />
              <span className={`${styles.activityLegendCell} ${styles.cell3}`} />
              <span className={`${styles.activityLegendCell} ${styles.cell4}`} />
              <span className={styles.activityLegend}>{t('activity.more')}</span>
            </span>
          </>
        )}
      </div>

      <div className={styles.cardFoot}>
        <span className={styles.cardFootLeft}>
          <span className={styles.cardFootDot} style={{ background: 'var(--status-working)' }} />
          {t('activity.streak', { n: streak })}
        </span>
        <span className={styles.cardFootRight}>
          {t('activity.total', { total: totalFormatted })}
        </span>
      </div>
    </div>
  )
}
