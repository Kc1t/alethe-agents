import { ChevronDown, Coins } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { AgentIcon } from '../icons/AgentIcons'
import { fmtTokens, fmtUsd, costLevel } from '../../lib/costFormat'
import { basename } from '../../lib/paths'
import { useT } from '../../lib/i18n'
import { useAgentCostStore, selectCostTotals } from '../../stores/agentCostStore'
import { useProjectsStore } from '../../stores/projectsStore'
import type { AgentType } from '../../lib/types'
import styles from './TokenHud.module.css'

const POLL_MS = 4000

function shortCwd(cwd: string): string {
  return basename(cwd) || cwd
}

function costClass(v: number): string {
  const level = costLevel(v)
  if (level === 'high') return styles.costHigh
  if (level === 'mid') return styles.costMid
  return styles.costLow
}

export function TokenHud() {
  const t = useT()
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const byPtyId = useAgentCostStore((s) => s.byPtyId)
  const refresh = useAgentCostStore((s) => s.refresh)
  const [collapsed, setCollapsed] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    void refresh()
    timer.current = window.setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [refresh])

  const entries = Object.values(byPtyId)
  if (entries.length === 0) return null

  const totals = selectCostTotals({ byPtyId, refresh })

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.pill}
        onClick={() => setCollapsed(false)}
        aria-label={t('hud.expand')}
        title={t('hud.expand')}
      >
        <Coins size={13} aria-hidden />
        <span className={`${styles.pillCost} ${costClass(totals.costUsd)}`}>
          {fmtUsd(totals.costUsd)}
        </span>
        <span className={styles.pillCount}>{t('hud.agentsRunning', { count: totals.agents })}</span>
      </button>
    )
  }

  return (
    <section className={styles.panel} aria-label={t('hud.title')}>
      <header className={styles.head}>
        <span className={styles.headTitle}>
          <Coins size={13} aria-hidden /> {t('hud.title')}
        </span>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={() => setCollapsed(true)}
          aria-label={t('hud.collapse')}
          title={t('hud.collapse')}
        >
          <ChevronDown size={14} />
        </button>
      </header>

      <ul className={styles.list}>
        {entries.map((e) => {
          const cost = e.cost
          const usd = cost?.cost_usd ?? null
          return (
            <li key={e.ptyId} className={styles.row}>
              <span className={styles.rowIcon} aria-hidden>
                <AgentIcon type={e.agent as AgentType} size={14} theme={uiTheme} />
              </span>
              <span className={styles.rowLabel}>
                <strong>{shortCwd(e.cwd)}</strong>
                <span className={styles.rowMeta}>
                  {cost?.model ?? e.agent} · {fmtTokens(cost?.total_tokens ?? 0)} {t('hud.tokens')}
                </span>
              </span>
              <span
                className={`${styles.rowCost} ${usd != null ? costClass(usd) : styles.costNone}`}
              >
                {usd != null ? fmtUsd(usd) : t('hud.noCost')}
              </span>
            </li>
          )
        })}
      </ul>

      <footer className={styles.foot}>
        <span>{t('hud.total')}</span>
        <span className={`${styles.footCost} ${costClass(totals.costUsd)}`}>
          {fmtUsd(totals.costUsd)}
        </span>
      </footer>
    </section>
  )
}
