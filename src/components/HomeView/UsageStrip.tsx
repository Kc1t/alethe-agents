import { Clock, RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { loadClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { getCachedKimiUsage } from '../../lib/kimiUsageCache'
import { translate, getLocale, useT } from '../../lib/i18n'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { USAGE_PROVIDERS, type UsageProviderDef } from '../../lib/usageProviders'
import {
  codexHeadlineWindow,
  hasCodexWindow,
  type AntigravityUsage,
  type ClaudeUsage,
  type CodexUsage,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AntigravityIcon, ClaudeIcon, CodexIcon, KimiIcon } from '../icons/AgentIcons'
import { ActivityGraph } from './ActivityGraph'
import styles from './HomeView.module.css'

function formatDiff(diff: number): string {
  if (Number.isNaN(diff)) return '—'
  if (diff <= 0) return translate(getLocale(), 'widget.resetting')
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function formatResetTime(resetsAt: string): string {
  if (!resetsAt) return '—'
  try {
    return formatDiff(new Date(resetsAt).getTime() - Date.now())
  } catch {
    return resetsAt
  }
}

function formatResetMs(resetsAtMs: number): string {
  if (!resetsAtMs) return '—'
  return formatDiff(resetsAtMs - Date.now())
}

function meterColor(util: number, base: string): string {
  if (util >= 80) return 'var(--status-offline)'
  if (util >= 50) return 'var(--status-waiting)'
  return base
}

function pctNum(v: number): number {
  return Math.round(v)
}

async function refreshClaude(): Promise<void> {
  await loadClaudeUsage(true)
}

async function refreshCodex(): Promise<void> {
  const { setCodexUsage } = useUiStore.getState()
  try {
    setCodexUsage(await getCachedCodexUsage(true))
  } catch {
    setCodexUsage(null)
  }
}

async function refreshKimi(): Promise<void> {
  const { setKimiUsage } = useUiStore.getState()
  try {
    setKimiUsage(await getCachedKimiUsage(true))
  } catch {
    setKimiUsage(null)
  }
}

async function refreshAntigravity(): Promise<void> {
  const { setAntigravityUsage } = useUiStore.getState()
  try {
    setAntigravityUsage(await getCachedAntigravityUsage(true))
  } catch {
    setAntigravityUsage(null)
  }
}

const PROVIDER_CARD: Record<
  UsageProviderDef['id'],
  { name: string; badgeClass: string; icon: ReactNode; refresh: () => Promise<void> }
> = {
  claude: {
    name: 'claude code',
    badgeClass: styles.badgeClaude,
    icon: <ClaudeIcon size={16} />,
    refresh: refreshClaude,
  },
  codex: {
    name: 'codex',
    badgeClass: styles.badgeCodex,
    icon: <CodexIcon size={16} />,
    refresh: refreshCodex,
  },
  antigravity: {
    name: 'antigravity',
    badgeClass: styles.badgeAntigravity,
    icon: <AntigravityIcon size={16} />,
    refresh: refreshAntigravity,
  },
  kimi: {
    name: 'kimi code',
    badgeClass: styles.badgeKimi,
    icon: <KimiIcon size={16} />,
    refresh: refreshKimi,
  },
}

/** Stands in for a provider whose usage reading is off: says so and offers to turn it on. */
function UsageOffCard({ providerId }: { providerId: UsageProviderDef['id'] }) {
  const t = useT()
  const provider = USAGE_PROVIDERS.find((entry) => entry.id === providerId)!
  const card = PROVIDER_CARD[providerId]

  const turnOn = () => {
    const { preferences, setPreferences } = useProjectsStore.getState()
    setPreferences({ usageAccess: { ...preferences.usageAccess, [providerId]: true } })
    void card.refresh()
  }

  return (
    <div className={styles.usageCard}>
      <div className={styles.cardHead}>
        <div className={`${styles.badge} ${card.badgeClass}`}>{card.icon}</div>
        <span className={styles.name}>{card.name}</span>
      </div>
      <div className={styles.usageEmpty}>
        <span className={styles.usageEmptyTitle}>{t('widget.usageOff')}</span>
        <span className={styles.usageEmptyHint}>
          {t('widget.usageOffHint', {
            provider: AGENT_TYPE_LABELS[provider.agentType],
            vendor: provider.vendor,
          })}
        </span>
        <button type="button" className={styles.usageEmptyAction} onClick={turnOn}>
          {t('widget.turnOnUsage')}
        </button>
      </div>
    </div>
  )
}

function CardHead({
  badgeClass,
  icon,
  name,
  plan,
  accent,
  hasData,
  onRefresh,
}: {
  badgeClass: string
  icon: ReactNode
  name: string
  plan?: string
  accent: string
  hasData: boolean
  onRefresh: () => Promise<void>
}) {
  const t = useT()
  const [refreshing, setRefreshing] = useState(false)
  const handle = async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <div className={styles.cardHead}>
      <div className={`${styles.badge} ${badgeClass}`}>{icon}</div>
      <span className={styles.name}>{name}</span>
      {plan && <span className={styles.plan}>{plan}</span>}
      <div className={styles.headRight}>
        {hasData && (
          <span className={styles.live}>
            <span className={styles.liveDot} style={{ background: accent }} />
            {t('widget.live')}
          </span>
        )}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={handle}
          disabled={refreshing}
          title={hasData ? t('widget.refreshUsage') : t('widget.tryAgain')}
        >
          <RefreshCw size={12} className={refreshing ? styles.iconBtnSpin : undefined} />
        </button>
      </div>
    </div>
  )
}

function Hero({
  percent,
  reset,
  sub,
  critical,
}: {
  percent: number
  reset: string
  sub: ReactNode
  critical?: boolean
}) {
  return (
    <>
      <div className={styles.hero}>
        <div className={styles.heroNumWrap}>
          <span className={styles.heroNum}>{pctNum(percent)}</span>
          <span className={styles.heroDen}>%</span>
        </div>
        <span className={styles.timechip}>
          <Clock size={11} />
          <b>{reset}</b>
        </span>
      </div>
      <div className={`${styles.heroSub} ${critical ? styles.heroSubCrit : ''}`}>{sub}</div>
    </>
  )
}

function Meter({
  label,
  reset,
  value,
  util,
  base,
}: {
  label: string
  reset?: string
  value: string
  util: number
  base: string
}) {
  const color = meterColor(util, base)
  const pulse = util >= 80
  return (
    <div className={styles.meter}>
      <div className={styles.meterRow}>
        <span className={styles.meterLabel}>
          {label}
          {reset && <span className={styles.meterReset}>{reset}</span>}
        </span>
        <span className={styles.meterValue}>{value}</span>
      </div>
      <div className={styles.meterBar}>
        <div
          className={`${styles.meterFill} ${pulse ? styles.meterFillPulse : ''}`}
          style={{ width: `${Math.min(util, 100)}%`, background: color }}
        />
      </div>
    </div>
  )
}

function CardFoot({ accent, left, right }: { accent: string; left: ReactNode; right: ReactNode }) {
  return (
    <div className={styles.cardFoot}>
      <span className={styles.cardFootLeft}>
        <span className={styles.cardFootDot} style={{ background: accent }} />
        {left}
      </span>
      <span className={styles.cardFootRight}>{right}</span>
    </div>
  )
}

function StatCell({ label, value, crit }: { label: string; value: string; crit?: boolean }) {
  return (
    <div className={styles.statCell}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${crit ? styles.statValueCrit : ''}`}>{value}</span>
    </div>
  )
}

function ClaudeCard({ usage }: { usage: ClaudeUsage | null }) {
  const t = useT()
  const usageError = useUiStore((s) => s.claudeUsageError)
  const accent = 'var(--agent-claude)'

  const head = (
    <CardHead
      badgeClass={styles.badgeClaude}
      icon={<ClaudeIcon size={16} />}
      name="claude code"
      plan={usage ? 'max · 5x' : undefined}
      accent={accent}
      // A reading kept from before a failed refresh is not live.
      hasData={!!usage && !usageError}
      onRefresh={refreshClaude}
    />
  )

  if (!usage) {
    const unavailable = usageError === 'unavailable'
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>
            {unavailable ? t('widget.usageUnavailable') : t('widget.noTokenConfigured')}
          </span>
          <span className={styles.usageEmptyHint}>
            {unavailable ? t('widget.usageUnavailableHint') : t('widget.connectToSeeUsage')}
          </span>
        </div>
      </div>
    )
  }

  const modelLimits = usage.model_limits ?? []
  const maxUtil = Math.max(
    usage.five_hour.utilization,
    usage.seven_day.utilization,
    usage.seven_day_opus.utilization,
    ...modelLimits.map((limit) => limit.utilization),
  )

  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={usage.five_hour.utilization}
        reset={formatResetTime(usage.five_hour.resets_at)}
        critical={usage.five_hour.utilization >= 80}
        sub={
          <>
            {t('widget.usage5h')} ·{' '}
            <b>
              {t('widget.week')} {pctNum(usage.seven_day.utilization)}%
            </b>
          </>
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          <Meter
            label="5h"
            value={`${pctNum(usage.five_hour.utilization)}%`}
            util={usage.five_hour.utilization}
            base={accent}
          />
          <Meter
            label={t('widget.week')}
            value={`${pctNum(usage.seven_day.utilization)}%`}
            util={usage.seven_day.utilization}
            base={accent}
          />
          <Meter
            label="opus"
            value={`${pctNum(usage.seven_day_opus.utilization)}%`}
            util={usage.seven_day_opus.utilization}
            base={accent}
          />
          {modelLimits.map((limit) => (
            <Meter
              key={limit.model}
              label={limit.model.toLowerCase()}
              value={`${pctNum(limit.utilization)}%`}
              util={limit.utilization}
              base={accent}
            />
          ))}
        </div>
        <div className={styles.statGrid}>
          <StatCell
            label={t('widget.resetLabel', { w: '5h' })}
            value={formatResetTime(usage.five_hour.resets_at)}
          />
          <StatCell
            label={t('widget.resetLabel', { w: t('widget.week') })}
            value={formatResetTime(usage.seven_day.resets_at)}
          />
          <StatCell
            label={t('widget.resetLabel', { w: 'opus' })}
            value={formatResetTime(usage.seven_day_opus.resets_at)}
          />
          <StatCell
            label={t('widget.peakLabel')}
            value={`${pctNum(maxUtil)}%`}
            crit={maxUtil >= 80}
          />
        </div>
      </div>
      <CardFoot
        accent={accent}
        left={[
          '5h',
          t('widget.week'),
          'opus',
          ...modelLimits.map((l) => l.model.toLowerCase()),
        ].join(' · ')}
        right={t('widget.peak', { v: `${pctNum(maxUtil)}%` })}
      />
    </div>
  )
}

function CodexCard({
  usage,
  showResetCreditAction,
}: {
  usage: CodexUsage | null
  showResetCreditAction: boolean
}) {
  const t = useT()
  const openModal = useUiStore((s) => s.openModal_)
  const accent = 'var(--agent-codex)'

  const head = (
    <CardHead
      badgeClass={styles.badgeCodex}
      icon={<CodexIcon size={16} />}
      name="codex"
      plan={usage?.plan || undefined}
      accent={accent}
      hasData={!!usage}
      onRefresh={refreshCodex}
    />
  )

  if (!usage) {
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>{t('widget.codexNotSignedIn')}</span>
          <span className={styles.usageEmptyHint}>{t('widget.codexSignInHint')}</span>
        </div>
      </div>
    )
  }

  const maxUtil = Math.max(usage.primary.used_percent, usage.secondary.used_percent)
  const has5h = hasCodexWindow(usage.primary)
  const headline = codexHeadlineWindow(usage)

  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={headline.used_percent}
        reset={formatResetMs(headline.resets_at_ms)}
        critical={usage.rate_limited || headline.used_percent >= 80}
        sub={
          usage.rate_limited ? (
            t('widget.limitReached')
          ) : has5h ? (
            <>
              {t('widget.usage5h')} ·{' '}
              <b>
                {t('widget.week')} {pctNum(usage.secondary.used_percent)}%
              </b>
            </>
          ) : (
            t('widget.week')
          )
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          {has5h ? (
            <Meter
              label="5h"
              value={`${pctNum(usage.primary.used_percent)}%`}
              util={usage.primary.used_percent}
              base={accent}
            />
          ) : null}
          <Meter
            label={t('widget.week')}
            value={`${pctNum(usage.secondary.used_percent)}%`}
            util={usage.secondary.used_percent}
            base={accent}
          />
        </div>
        <div className={styles.statGrid}>
          {has5h ? (
            <StatCell
              label={t('widget.resetLabel', { w: '5h' })}
              value={formatResetMs(usage.primary.resets_at_ms)}
            />
          ) : null}
          <StatCell
            label={t('widget.resetLabel', { w: t('widget.week') })}
            value={formatResetMs(usage.secondary.resets_at_ms)}
          />
          <StatCell
            label={t('widget.statusLabel')}
            value={usage.rate_limited ? t('widget.statusLimited') : t('widget.statusOk')}
            crit={usage.rate_limited}
          />
        </div>
        {showResetCreditAction && usage.reset_credits > 0 ? (
          <div className={styles.resetCreditBox}>
            <span className={styles.resetCreditTitle}>{t('widget.resetCreditHeading')}</span>
            <button
              type="button"
              className={styles.resetCreditButton}
              onClick={() => openModal('resetCredit')}
            >
              {t('widget.resetCredits', { n: usage.reset_credits })}
            </button>
          </div>
        ) : null}
      </div>
      <CardFoot
        accent={accent}
        left={has5h ? `5h · ${t('widget.week')}` : t('widget.week')}
        right={t('widget.peak', { v: `${pctNum(maxUtil)}%` })}
      />
    </div>
  )
}

function AntigravityCard({ usage }: { usage: AntigravityUsage | null }) {
  const t = useT()
  const accent = 'var(--agent-antigravity)'

  const hasData = usage?.status === 'ready' && usage.buckets.length > 0
  const head = (
    <CardHead
      badgeClass={styles.badgeAntigravity}
      icon={<AntigravityIcon size={16} />}
      name="antigravity"
      plan={hasData ? `${usage.buckets.length} ${t('widget.quotaBucketsShort')}` : undefined}
      accent={accent}
      hasData={hasData}
      onRefresh={refreshAntigravity}
    />
  )

  if (!usage || !hasData) {
    const emptyTitle =
      usage?.status === 'no_cli'
        ? t('widget.antigravityNotInstalled')
        : usage?.status === 'no_auth'
          ? t('widget.antigravityNotSignedIn')
          : t('widget.usageUnavailable')
    return (
      <div className={styles.usageCard}>
        {head}
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>{emptyTitle}</span>
          <span className={styles.usageEmptyHint}>{t('widget.antigravityUsageHint')}</span>
        </div>
      </div>
    )
  }

  const primary = usage.buckets[0]
  return (
    <div className={styles.usageCard}>
      {head}
      <Hero
        percent={usage.used_percent}
        reset={formatResetTime(primary.resets_at)}
        critical={usage.rate_limited || usage.used_percent >= 80}
        sub={
          usage.rate_limited
            ? t('widget.limitReached')
            : t('widget.mostUsedBucket', { name: primary.label })
        }
      />
      <div className={styles.cardBody}>
        <div className={styles.meterList}>
          {usage.buckets.map((bucket) => (
            <Meter
              key={`${bucket.label}:${bucket.resets_at}`}
              label={bucket.label}
              reset={formatResetTime(bucket.resets_at)}
              value={`${pctNum(bucket.used_percent)}%`}
              util={bucket.used_percent}
              base={accent}
            />
          ))}
        </div>
        <div className={styles.statGrid}>
          <StatCell
            label={t('widget.statusLabel')}
            value={usage.rate_limited ? t('widget.statusLimited') : t('widget.statusOk')}
            crit={usage.rate_limited}
          />
          <StatCell
            label={t('widget.remainingLabel')}
            value={`${pctNum(primary.remaining_percent)}%`}
            crit={primary.remaining_percent <= 1}
          />
          <StatCell
            label={t('widget.modelsLabel')}
            value={String(usage.buckets.reduce((sum, bucket) => sum + bucket.models.length, 0))}
          />
          <StatCell
            label={t('widget.peakLabel')}
            value={`${pctNum(usage.used_percent)}%`}
            crit={usage.used_percent >= 80}
          />
        </div>
      </div>
      <CardFoot
        accent={accent}
        left={usage.buckets.map((bucket) => bucket.label).join(' · ')}
        right={t('widget.quotaBuckets', { n: usage.buckets.length })}
      />
    </div>
  )
}

function KimiCard() {
  const t = useT()
  const usage = useUiStore((s) => s.kimiUsage)
  const setUsage = useUiStore((s) => s.setKimiUsage)
  const accent = 'var(--agent-kimi)'
  const ready = usage?.status === 'ready' && usage.windows.length > 0
  const label = (key: string) =>
    key === 'limit_5h'
      ? '5h'
      : key === 'limit_7d'
        ? t('widget.week')
        : key === 'limit_month_code'
          ? t('widget.kimiMonthlyCode')
          : t('widget.kimiMonthlyTotal')
  const refresh = async () => {
    try {
      setUsage(await getCachedKimiUsage(true))
    } catch {
      setUsage(null)
    }
  }
  return (
    <div className={styles.usageCard}>
      <CardHead
        badgeClass={styles.badgeKimi}
        icon={<KimiIcon size={16} />}
        name="Kimi Code"
        accent={accent}
        hasData={ready}
        onRefresh={refresh}
      />
      {ready ? (
        <>
          <Hero
            percent={usage.windows[0].used_percent}
            reset={formatResetTime(usage.windows[0].resets_at)}
            critical={usage.windows[0].used_percent >= 80}
            sub={label(usage.windows[0].label)}
          />
          <div className={styles.cardBody}>
            <div className={styles.meterList}>
              {usage.windows.map((window) => (
                <Meter
                  key={window.label}
                  label={label(window.label)}
                  reset={formatResetTime(window.resets_at)}
                  value={`${pctNum(window.used_percent)}%`}
                  util={window.used_percent}
                  base={accent}
                />
              ))}
            </div>
          </div>
          <CardFoot
            accent={accent}
            left={t('widget.live')}
            right={t('widget.peak', {
              v: `${pctNum(Math.max(...usage.windows.map((w) => w.used_percent)))}%`,
            })}
          />
        </>
      ) : (
        <div className={styles.usageEmpty}>
          <span className={styles.usageEmptyTitle}>
            {usage?.status === 'no_auth'
              ? t('widget.kimiNotSignedIn')
              : t('widget.usageUnavailable')}
          </span>
          <span className={styles.usageEmptyHint}>{t('widget.kimiUsageHint')}</span>
        </div>
      )}
    </div>
  )
}

export function UsageStrip({
  showActivity = true,
  showResetCreditAction = false,
}: {
  showActivity?: boolean
  showResetCreditAction?: boolean
}) {
  const t = useT()
  const claudeUsage = useUiStore((s) => s.claudeUsage)
  const codexUsage = useUiStore((s) => s.codexUsage)
  const antigravityUsage = useUiStore((s) => s.antigravityUsage)
  const showClaude = useProjectsStore((s) => s.preferences.usageShowClaude)
  const showCodex = useProjectsStore((s) => s.preferences.usageShowCodex)
  const showAntigravity = useProjectsStore((s) => s.preferences.usageShowAntigravity)
  const showKimi = useProjectsStore((s) => s.preferences.usageShowKimi ?? true)
  const access = useProjectsStore((s) => s.preferences.usageAccess)

  if (!showClaude && !showCodex && !showAntigravity && !showKimi) {
    return (
      <div className={`${styles.usageStrip} ${showActivity ? '' : styles.usageStripTwo}`}>
        <div className={styles.usageEmpty}>{t('usageModal.allHidden')}</div>
      </div>
    )
  }

  return (
    <div className={`${styles.usageStrip} ${showActivity ? '' : styles.usageStripTwo}`}>
      {!showClaude ? null : access.claude ? (
        <ClaudeCard usage={claudeUsage} />
      ) : (
        <UsageOffCard providerId="claude" />
      )}
      {!showCodex ? null : access.codex ? (
        <CodexCard usage={codexUsage} showResetCreditAction={showResetCreditAction} />
      ) : (
        <UsageOffCard providerId="codex" />
      )}
      {showActivity || !showAntigravity ? null : access.antigravity ? (
        <AntigravityCard usage={antigravityUsage} />
      ) : (
        <UsageOffCard providerId="antigravity" />
      )}
      {!showKimi ? null : access.kimi ? <KimiCard /> : <UsageOffCard providerId="kimi" />}
      {showActivity ? <ActivityGraph /> : null}
    </div>
  )
}
