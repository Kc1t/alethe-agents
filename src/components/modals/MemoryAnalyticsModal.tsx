import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FolderOpen,
  Layers,
  Monitor,
  TerminalSquare,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { intlLocale, type Locale, type TFunction,useT } from '../../lib/i18n'
import { type CrashReport,getJobGuardStatus, getLastCrashReport, openLogsFolder } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import type { MemorySample } from '../../stores/uiStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import styles from './MemoryAnalyticsModal.module.css'
import { Modal } from './Modal'

type Bucket = 'app_mb' | 'webview_mb' | 'ptys_mb'
type MemoryHealthLevel = 'normal' | 'warning' | 'critical'

const BUCKETS: Array<{
  key: Bucket
  labelKey: 'mod.bucketApp' | 'mod.bucketWebview' | 'mod.bucketPtys'
  short: string
}> = [
  { key: 'app_mb', labelKey: 'mod.bucketApp', short: 'App' },
  { key: 'webview_mb', labelKey: 'mod.bucketWebview', short: 'Web' },
  { key: 'ptys_mb', labelKey: 'mod.bucketPtys', short: 'PTY' },
]

function formatMb(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return `${value.toFixed(value >= 100 ? 0 : 1)} MB`
}

function formatTime(ts: number, language: Locale): string {
  return new Date(ts).toLocaleTimeString(intlLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function average(
  samples: MemorySample[],
  key: keyof Pick<MemorySample, 'total_mb' | Bucket>,
): number {
  if (samples.length === 0) return 0
  return samples.reduce((sum, sample) => sum + Number(sample[key]), 0) / samples.length
}

function getGrowth(
  samples: MemorySample[],
  key: keyof Pick<MemorySample, 'total_mb' | Bucket>,
): number {
  if (samples.length < 2) return 0
  return Number(samples[samples.length - 1][key]) - Number(samples[0][key])
}

function dominantBucket(
  sample: MemorySample | null,
  t: TFunction,
): { label: string; value: number; share: number } | null {
  if (!sample || sample.total_mb <= 0) return null
  const top = BUCKETS.map((bucket) => ({
    label: t(bucket.labelKey),
    value: sample[bucket.key],
    share: sample[bucket.key] / sample.total_mb,
  })).sort((a, b) => b.value - a.value)[0]
  return top ?? null
}

function memoryHealth(sample: MemorySample | null): MemoryHealthLevel {
  if (!sample || sample.system_total_mb <= 0) return 'normal'
  const criticalAt = Math.max(512, sample.system_total_mb * 0.05)
  const warningAt = Math.max(1024, sample.system_total_mb * 0.1)
  if (sample.system_available_mb <= criticalAt) return 'critical'
  if (sample.system_available_mb <= warningAt) return 'warning'
  return 'normal'
}

function buildDiagnostics(history: MemorySample[], t: TFunction): string[] {
  if (history.length === 0) return [t('mod.noDataYet')]

  const latest = history[history.length - 1]
  const recent = history.filter((sample) => latest.ts - sample.ts <= 10 * 60_000)
  const windowed = recent.length >= 2 ? recent : history
  const totalGrowth = getGrowth(windowed, 'total_mb')
  const bucketGrowth = BUCKETS.map((bucket) => ({
    label: t(bucket.labelKey),
    value: getGrowth(windowed, bucket.key),
  })).sort((a, b) => b.value - a.value)[0]
  const top = dominantBucket(latest, t)
  const diagnostics: string[] = []

  const health = memoryHealth(latest)
  if (health === 'critical') diagnostics.push(t('mod.diagSystemCritical'))
  else if (health === 'warning') diagnostics.push(t('mod.diagSystemWarning'))

  if (totalGrowth >= 512) {
    diagnostics.push(t('mod.diagHighGrowth', { value: formatMb(totalGrowth) }))
  } else if (totalGrowth >= 256) {
    diagnostics.push(t('mod.diagModerateGrowth', { value: formatMb(totalGrowth) }))
  }

  if (bucketGrowth && bucketGrowth.value >= 192) {
    diagnostics.push(
      t('mod.diagBucketGrowth', { label: bucketGrowth.label, value: formatMb(bucketGrowth.value) }),
    )
  }

  if (top && top.share >= 0.6) {
    diagnostics.push(t('mod.diagDominant', { label: top.label, pct: (top.share * 100).toFixed(0) }))
  }

  if (latest.process_count >= 50) {
    diagnostics.push(t('mod.diagManyProcesses', { count: latest.process_count }))
  }

  if (diagnostics.length === 0) {
    diagnostics.push(t('mod.diagStable'))
  }

  return diagnostics
}

type ChartPoint = { x: number; y: number }

                                                                          
                                                                      
                                              
function smoothPath(points: ChartPoint[]): string {
  if (points.length < 2) return ''
  if (points.length === 2) {
    return `M ${points[0].x},${points[0].y} L ${points[1].x},${points[1].y}`
  }
  let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`
  }
  return d
}

function Sparkline({ samples }: { samples: MemorySample[] }) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const chartSamples = samples.slice(-90)
  if (chartSamples.length < 2) {
    return <div className={styles.emptyChart}>{t('mod.waitingMoreSamples')}</div>
  }

  const values = chartSamples.map((sample) => sample.total_mb)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = Math.max(max - min, 1)
  const points: ChartPoint[] = chartSamples.map((sample, index) => ({
    x: (index / (chartSamples.length - 1)) * 100,
    y: 100 - ((sample.total_mb - min) / range) * 84 - 8,
  }))
  const linePath = smoothPath(points)
  const lastX = points[points.length - 1].x.toFixed(2)
  const areaPath = `${linePath} L ${lastX},100 L 0,100 Z`

  const hovered = hoverIndex != null ? chartSamples[hoverIndex] : null
  const hoveredPoint = hoverIndex != null ? points[hoverIndex] : null

  const handleMove = (event: React.PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    setHoverIndex(Math.round(pct * (chartSamples.length - 1)))
  }

  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="memChartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className={styles.chartArea} d={areaPath} fill="url(#memChartFill)" />
        <path className={styles.chartLine} d={linePath} />
        {hoveredPoint ? (
          <>
            <line
              className={styles.chartCrosshair}
              x1={hoveredPoint.x}
              x2={hoveredPoint.x}
              y1={4}
              y2={96}
            />
            <circle className={styles.chartDot} cx={hoveredPoint.x} cy={hoveredPoint.y} r={2.4} />
          </>
        ) : null}
        <rect
          className={styles.chartHitArea}
          x={0}
          y={0}
          width={100}
          height={100}
          onPointerMove={handleMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>
      <div className={styles.chartScale}>
        <span>{formatMb(max)}</span>
        <span>{formatMb(min)}</span>
      </div>
      {hovered && hoveredPoint ? (
        <div
          className={styles.chartTooltip}
          style={{ left: `${Math.min(90, Math.max(2, hoveredPoint.x))}%` }}
        >
          <strong>{formatMb(hovered.total_mb)}</strong>
          <span>{formatTime(hovered.ts, language)}</span>
        </div>
      ) : null}
    </div>
  )
}

function CategoryBars({ latest }: { latest: MemorySample | null }) {
  const t = useT()
  if (!latest || latest.total_mb <= 0) return null

  return (
    <div className={styles.categoryList}>
      {BUCKETS.map((bucket) => {
        const value = latest[bucket.key]
        const pct = Math.max(2, (value / latest.total_mb) * 100)
        return (
          <div key={bucket.key} className={styles.categoryRow}>
            <div className={styles.categoryMeta}>
              <span>{t(bucket.labelKey)}</span>
              <span>{formatMb(value)}</span>
            </div>
            <div className={styles.barTrack}>
              <div className={styles.barFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function MemoryAnalyticsModal() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const open = useUiStore((s) => s.openModal === 'memoryAnalytics')
  const onClose = useUiStore((s) => s.closeModal)
  const history = useUiStore((s) => s.memoryHistory)
  const runtimeSnapshot = useUiStore((s) => s.runtimeSnapshot)
  const clearMemoryHistory = useUiStore((s) => s.clearMemoryHistory)

                                                                      
  const [crash, setCrash] = useState<CrashReport | null>(null)
  useEffect(() => {
    void getLastCrashReport()
      .then(setCrash)
      .catch(() => {})
  }, [])

                                                                       
                                                                             
  // saber de verdade.
  const [jobGuardActive, setJobGuardActive] = useState<boolean | null>(null)
  useEffect(() => {
    void getJobGuardStatus()
      .then(setJobGuardActive)
      .catch(() => setJobGuardActive(false))
  }, [])

  const latest = history[history.length - 1] ?? null
  const health = memoryHealth(latest)
  const peak = history.reduce<MemorySample | null>(
    (current, sample) => (!current || sample.total_mb > current.total_mb ? sample : current),
    null,
  )
  const recent = latest ? history.filter((sample) => latest.ts - sample.ts <= 10 * 60_000) : []
  const windowed = recent.length >= 2 ? recent : history
  const avg = average(windowed, 'total_mb')
  const growth = getGrowth(windowed, 'total_mb')
  const diagnostics = buildDiagnostics(history, t)
  const top = dominantBucket(latest, t)
  const latestRows = history.slice(-12).reverse()
  const runtimeRows = [...(runtimeSnapshot?.ptys ?? [])].sort(
    (a, b) => b.effectiveMemoryMb - a.effectiveMemoryMb,
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mod.memoryAnalyticsTitle')}
      width={760}
      footer={
        <button
          type="button"
          className={controls.btn}
          onClick={clearMemoryHistory}
          disabled={history.length === 0}
        >
          <Trash2 size={14} />
          {t('mod.clearHistory')}
        </button>
      }
    >
      <div className={styles.layout}>
        {crash ? (
          <section className={`${styles.panel} ${styles.crashPanel}`}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.lastSessionCrashTitle')}</h3>
                <p>
                  {t('mod.lastSessionCrashSubtitle', {
                    total: Math.round(crash.session.total_mb),
                    ptys: Math.round(crash.session.ptys_mb),
                    procs: crash.session.process_count,
                    time: formatTime(crash.session.last_heartbeat_ms || crash.session.started_at_ms, language),
                  })}
                </p>
                {crash.orphans_reaped > 0 ? (
                  <p>{t('mod.orphansReapedAtBoot', { count: crash.orphans_reaped })}</p>
                ) : null}
              </div>
              <AlertTriangle size={16} />
            </div>
            <div className={styles.crashActions}>
              <button
                type="button"
                className={controls.btn}
                onClick={() => void openLogsFolder().catch(() => {})}
              >
                <FolderOpen size={14} />
                {t('mod.openLogs')}
              </button>
            </div>
          </section>
        ) : null}

        {jobGuardActive !== null ? (
          <p className={styles.jobGuardStatus}>
            {jobGuardActive ? t('mod.jobGuardActive') : t('mod.jobGuardInactive')}
          </p>
        ) : null}

        <section className={`${styles.panel} ${styles.healthPanel}`} data-level={health}>
          <div className={styles.panelHeader}>
            <div>
              <h3>{t(`mod.health.${health}.title`)}</h3>
              <p>
                {latest
                  ? t(`mod.health.${health}.body`, {
                      available: formatMb(latest.system_available_mb),
                      total: formatMb(latest.system_total_mb),
                    })
                  : t('mod.waitingData')}
              </p>
            </div>
            {health === 'normal' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          </div>
        </section>

        <section className={styles.summaryGrid}>
          <div className={styles.metric}>
            <Activity size={16} />
            <span className={styles.metricLabel}>{t('mod.now')}</span>
            <strong>{latest ? formatMb(latest.total_mb) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Monitor size={16} />
            <span className={styles.metricLabel}>{t('mod.peak')}</span>
            <strong>{peak ? formatMb(peak.total_mb) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Cpu size={16} />
            <span className={styles.metricLabel}>{t('mod.recentAvg')}</span>
            <strong>{history.length ? formatMb(avg) : '-'}</strong>
          </div>
          <div className={styles.metric}>
            <Layers size={16} />
            <span className={styles.metricLabel}>{t('mod.trend')}</span>
            <strong
              className={growth >= 120 ? styles.hot : growth <= -80 ? styles.cool : undefined}
            >
              {growth >= 0 ? '+' : ''}
              {formatMb(growth)}
            </strong>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>{t('mod.history')}</h3>
              <p>{t('mod.historySubtitle', { count: history.length })}</p>
            </div>
            {latest ? <span>{formatTime(latest.ts, language)}</span> : null}
          </div>
          <Sparkline samples={history} />
        </section>

        <div className={styles.columns}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.bottlenecks')}</h3>
                <p>
                  {top
                    ? t('mod.bottleneckLead', { label: top.label, value: formatMb(top.value) })
                    : t('mod.noCurrentReading')}
                </p>
              </div>
              <AlertTriangle size={16} />
            </div>
            <div className={styles.diagnostics}>
              {diagnostics.map((item) => (
                <div key={item} className={styles.diagnosticItem}>
                  {item}
                </div>
              ))}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.currentComposition')}</h3>
                <p>
                  {latest
                    ? t('mod.processesTracked', { count: latest.process_count })
                    : t('mod.waitingData')}
                </p>
              </div>
              <TerminalSquare size={16} />
            </div>
            <CategoryBars latest={latest} />
          </section>
        </div>

        {runtimeSnapshot ? (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>{t('mod.runtimeBreakdown')}</h3>
                <p>
                  {t('mod.runtimeBreakdownSubtitle', {
                    effective: formatMb(runtimeSnapshot.effectiveTotalMb),
                    private: formatMb(runtimeSnapshot.privateCommitMb),
                    count: runtimeRows.length,
                  })}
                </p>
              </div>
              <span className={styles.pressureBadge} data-level={runtimeSnapshot.pressure.level}>
                {t(`mod.pressure.${runtimeSnapshot.pressure.level}`)}
              </span>
            </div>
            <div className={styles.runtimeList}>
              {runtimeRows.length === 0 ? (
                <div className={styles.emptyRows}>{t('mod.noLiveRuntimes')}</div>
              ) : (
                runtimeRows.map((runtime) => (
                  <details key={runtime.id} className={styles.runtimeRow}>
                    <summary>
                      <span className={styles.runtimeIdentity}>
                        <strong>{runtime.command || t('mod.unknownRuntime')}</strong>
                        <small title={runtime.cwd ?? runtime.id}>{runtime.cwd ?? runtime.id}</small>
                      </span>
                      <span>{runtime.processCount} proc.</span>
                      <strong>{formatMb(runtime.effectiveMemoryMb)}</strong>
                    </summary>
                    <div className={styles.processList}>
                      <div className={styles.processHead}>
                        <span>PID</span>
                        <span>{t('mod.processName')}</span>
                        <span>{t('mod.workingSet')}</span>
                        <span>{t('mod.privateCommit')}</span>
                        <span>CPU</span>
                      </div>
                      {runtime.processes.map((process) => (
                        <div key={process.pid} className={styles.processRow}>
                          <span>{process.pid}</span>
                          <span title={process.name}>{process.name}</span>
                          <span>{formatMb(process.workingSetMb)}</span>
                          <span>{formatMb(process.privateCommitMb)}</span>
                          <span>{process.cpuPercent.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))
              )}
            </div>
          </section>
        ) : null}

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h3>{t('mod.latestSamples')}</h3>
              <p>{t('mod.latestSamplesSubtitle')}</p>
            </div>
          </div>
          <div className={styles.table}>
            <div className={`${styles.tableRow} ${styles.tableHead}`}>
              <span>{t('mod.colTime')}</span>
              <span>{t('mod.colTotal')}</span>
              <span>App</span>
              <span>WebView</span>
              <span>PTY</span>
              <span>{t('mod.colProc')}</span>
            </div>
            {latestRows.length === 0 ? (
              <div className={styles.emptyRows}>{t('mod.waitingFirstReading')}</div>
            ) : (
              latestRows.map((sample) => (
                <div key={sample.ts} className={styles.tableRow}>
                  <span>{formatTime(sample.ts, language)}</span>
                  <strong>{formatMb(sample.total_mb)}</strong>
                  <span>{formatMb(sample.app_mb)}</span>
                  <span>{formatMb(sample.webview_mb)}</span>
                  <span>{formatMb(sample.ptys_mb)}</span>
                  <span>{sample.process_count}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
