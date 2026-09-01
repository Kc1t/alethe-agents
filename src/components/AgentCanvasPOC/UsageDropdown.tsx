import { Clock, X } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { ClaudeUsage, CodexUsage } from '../../lib/tauri'
import { ClaudeIcon, CodexIcon } from '../icons/AgentIcons'
import styles from './AgentCanvasPOC.module.css'

export type UsageTab = 'claude' | 'codex'

                                                                             
function fmtReset(ms: number, nowLabel: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const diff = ms - Date.now()
  if (diff <= 0) return nowLabel
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

                                                                                  
function meterColor(util: number): string {
  if (util >= 80) return 'var(--status-offline)'
  if (util >= 50) return 'var(--status-waiting)'
  return 'var(--accent)'
}

function Row({ label, util, reset }: { label: string; util: number; reset: string }) {
  return (
    <div className={styles.usageRow}>
      <div className={styles.usageRowHead}>
        <span className={styles.usageRowLabel}>{label}</span>
        <span className={styles.usageRowReset}>
          <Clock size={10} /> {reset}
        </span>
        <span className={styles.usageRowPct}>{Math.round(util)}%</span>
      </div>
      <div className={styles.usageBar}>
        <div
          className={styles.usageBarFill}
          style={{ width: `${Math.min(Math.max(util, 0), 100)}%`, background: meterColor(util) }}
        />
      </div>
    </div>
  )
}

export function UsageDropdown({
  claudeUsage,
  codexUsage,
  tab,
  onTab,
  onClose,
  onForceFallback,
}: {
  claudeUsage: ClaudeUsage | null
  codexUsage: CodexUsage | null
  tab: UsageTab
  onTab: (tab: UsageTab) => void
  onClose: () => void
  onForceFallback: () => void
}) {
  const t = useT()
  const now = t('ws.now')

  return (
    <div className={styles.usageDropdown} role="dialog">
      <div className={styles.usageTabs}>
        <button
          type="button"
          className={tab === 'claude' ? styles.usageTabActive : styles.usageTab}
          onClick={() => onTab('claude')}
        >
          <ClaudeIcon size={13} /> claude code
        </button>
        <button
          type="button"
          className={tab === 'codex' ? styles.usageTabActive : styles.usageTab}
          onClick={() => onTab('codex')}
        >
          <CodexIcon size={13} /> codex
        </button>
        <button
          type="button"
          className={styles.usageClose}
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X size={13} />
        </button>
      </div>

      {tab === 'claude' ? (
        claudeUsage ? (
          <div className={styles.usageBody}>
            <Row
              label={t('ws.usage5hLabel')}
              util={claudeUsage.five_hour.utilization}
              reset={fmtReset(new Date(claudeUsage.five_hour.resets_at).getTime(), now)}
            />
            <Row
              label={t('ws.usageWeekLabel')}
              util={claudeUsage.seven_day.utilization}
              reset={fmtReset(new Date(claudeUsage.seven_day.resets_at).getTime(), now)}
            />
            <Row
              label={t('ws.usageOpusLabel')}
              util={claudeUsage.seven_day_opus.utilization}
              reset={fmtReset(new Date(claudeUsage.seven_day_opus.resets_at).getTime(), now)}
            />
            <button type="button" className={styles.usageAction} onClick={onForceFallback}>
              {t('ws.forceCodexFallback')}
            </button>
          </div>
        ) : (
          <div className={styles.usageEmpty}>{t('ws.usageNoClaude')}</div>
        )
      ) : codexUsage ? (
        <div className={styles.usageBody}>
          <Row
            label={t('ws.usage5hLabel')}
            util={codexUsage.primary.used_percent}
            reset={fmtReset(codexUsage.primary.resets_at_ms, now)}
          />
          <Row
            label={t('ws.usageWeekLabel')}
            util={codexUsage.secondary.used_percent}
            reset={fmtReset(codexUsage.secondary.resets_at_ms, now)}
          />
          <div className={styles.usageStats}>
            <span className={codexUsage.rate_limited ? styles.usageStatCrit : undefined}>
              {t('ws.usageStatus')}:{' '}
              {codexUsage.rate_limited ? t('ws.usageLimited') : t('ws.usageOk')}
            </span>
            {codexUsage.plan ? <span>{codexUsage.plan}</span> : null}
            <span>
              {t('ws.usageCredits')}: {codexUsage.reset_credits}
            </span>
          </div>
        </div>
      ) : (
        <div className={styles.usageEmpty}>{t('ws.usageNoCodex')}</div>
      )}
    </div>
  )
}
