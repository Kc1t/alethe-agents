import {
  ArrowLeft,
  Coins,
  Frame,
  PiggyBank,
  Plus,
  Trash2,
  Wallet,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { type MutableRefObject } from 'react'

import {
  USAGE_FALLBACK_THRESHOLD,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '../../lib/agentCanvasConfig'
import { costClassFor } from '../../lib/agentCanvasUtils'
import { fmtTokens, fmtUsd } from '../../lib/costFormat'
import { useT } from '../../lib/i18n'
import type { ClaudeUsage, CodexUsage } from '../../lib/tauri'
import { CodexIcon } from '../icons/AgentIcons'
import styles from './AgentCanvasPOC.module.css'
import { UsageDropdown, type UsageTab } from './UsageDropdown'

type CanvasTopBarProps = {
  onBack: () => void
  // Zoom
  zoom: number
  zoomBy: (delta: number) => void
  fitZoom: () => void
  // Uso / fallback
  usage: ClaudeUsage | null
  codexUsage: CodexUsage | null
  fallbackActive: boolean
  usageOpen: boolean
  setUsageOpen: (updater: (open: boolean) => boolean) => void
  usageTab: UsageTab
  onUsageTab: (tab: UsageTab) => void
  usageAnchorRef: MutableRefObject<HTMLDivElement | null>
  onForceFallback: () => void
                      
  hasCost: boolean
  sessionTokens: number
  sessionCostUsd: number
  routingSavings: number
  budgetUsd: number | null
  onBudget: (usd: number | null) => void
  // Contadores / hooks
  running: number
  done: number
  lastEventAt: number | null
  hooksEndpoint: string | null
          
  onOpenCodexWorker: () => void
  onClear: () => void
  clearDisabled: boolean
}

/** Canvas toolbar for navigation, zoom, usage, cost, budget, and actions. */
export function CanvasTopBar({
  onBack,
  zoom,
  zoomBy,
  fitZoom,
  usage,
  codexUsage,
  fallbackActive,
  usageOpen,
  setUsageOpen,
  usageTab,
  onUsageTab,
  usageAnchorRef,
  onForceFallback,
  hasCost,
  sessionTokens,
  sessionCostUsd,
  routingSavings,
  budgetUsd,
  onBudget,
  running,
  done,
  lastEventAt,
  hooksEndpoint,
  onOpenCodexWorker,
  onClear,
  clearDisabled,
}: CanvasTopBarProps) {
  const t = useT()
  return (
    <header className={styles.topBar}>
      <button type="button" className={styles.backButton} onClick={onBack}>
        <ArrowLeft size={14} />
        {t('ws.back')}
      </button>
      <span className={styles.title}>{t('ws.agentCanvasPoc')}</span>
      <div className={styles.topRight}>
        <div className={styles.zoomControls}>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => zoomBy(-ZOOM_STEP)}
            disabled={zoom <= ZOOM_MIN}
            title={t('ws.zoomOut')}
          >
            <ZoomOut size={14} />
          </button>
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={zoom >= ZOOM_MAX}
            title={t('ws.zoomIn')}
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            className={styles.clearButton}
            onClick={fitZoom}
            title={t('ws.zoomFit')}
          >
            <Frame size={14} />
          </button>
        </div>
        {usage || codexUsage ? (
          <div className={styles.usageAnchor} data-no-pan ref={usageAnchorRef}>
            <button
              type="button"
              className={
                (usage && usage.five_hour.utilization >= USAGE_FALLBACK_THRESHOLD) || fallbackActive
                  ? `${styles.usagePill} ${styles.usagePillCrit}`
                  : styles.usagePill
              }
              title={t('ws.usagePanelOpen')}
              onClick={() => setUsageOpen((o) => !o)}
              aria-expanded={usageOpen}
            >
              {usage
                ? t('ws.claude5h', { pct: Math.round(usage.five_hour.utilization) })
                : t('ws.codex5h', { pct: Math.round(codexUsage!.primary.used_percent) })}
            </button>
            {usageOpen ? (
              <UsageDropdown
                claudeUsage={usage}
                codexUsage={codexUsage}
                tab={usageTab}
                onTab={onUsageTab}
                onClose={() => setUsageOpen(() => false)}
                onForceFallback={onForceFallback}
              />
            ) : null}
          </div>
        ) : null}
        {hasCost ? (
          <span
            className={styles.costPill}
            title={t('ws.sessionCostTitle', { tokens: fmtTokens(sessionTokens) })}
          >
            <Coins size={12} />
            <span className={costClassFor(sessionCostUsd, styles)}>{fmtUsd(sessionCostUsd)}</span>
          </span>
        ) : null}
        {routingSavings > 0 ? (
          <span className={styles.savingsPill} title={t('ws.savingsTitle')}>
            <PiggyBank size={12} />
            {t('ws.savedRouting', { usd: fmtUsd(routingSavings) })}
          </span>
        ) : null}
        <label className={styles.budgetControl} title={t('ws.budgetTitle')}>
          <Wallet size={12} />
          <input
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            className={styles.budgetInput}
            value={budgetUsd ?? ''}
            placeholder={t('ws.budgetPlaceholder')}
            onChange={(e) => {
              const v = e.target.value
              onBudget(v === '' ? null : Math.max(0, Number(v)))
            }}
          />
        </label>
        <span className={styles.counter}>
          {t('ws.runningDone', { running, done })}
          {lastEventAt
            ? ''
            : ` · ${t('ws.waitingHooks', { endpoint: hooksEndpoint?.replace('http://127.0.0.1', ':') ?? '...' })}`}
        </span>
        <button
          type="button"
          className={styles.clearButton}
          onClick={onOpenCodexWorker}
          title={t('ws.openNewCodexTerminal')}
        >
          <Plus size={13} />
          <CodexIcon size={14} />
        </button>
        <button
          type="button"
          className={styles.clearButton}
          onClick={onClear}
          disabled={clearDisabled}
          title={t('ws.clearCanvas')}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </header>
  )
}
