import { useEffect } from 'react'

import { getLocale, translate } from '../lib/i18n'
import { notifyLowBalance } from '../lib/notifications'
import {
  formatUsd,
  type OpenRouterAlertLevel,
  openRouterAlertLevel,
  shouldWarn,
} from '../lib/openrouterAlerts'
import { getCachedOpenRouterUsage } from '../lib/openrouterUsageCache'
import type { OpenRouterUsage } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

const POLL_MS = 5 * 60_000
const STARTUP_DELAY_MS = 3500

/** The level last warned about, for the life of the window: a restart warns once more. */
let lastWarned: OpenRouterAlertLevel = 'none'

function warn(level: Exclude<OpenRouterAlertLevel, 'none'>, usage: OpenRouterUsage): void {
  const headline = usage.headline!
  const locale = getLocale()
  const days = usage.days_left
  const body = translate(locale, `openrouter.alert.${level}Body`, {
    remaining: formatUsd(headline.remaining_usd),
    pct: Math.round(headline.used_percent),
  })
  const pace =
    days !== null && level !== 'empty'
      ? ` ${translate(locale, 'openrouter.alert.pace', { days: Math.max(0, Math.round(days)) })}`
      : ''
  void notifyLowBalance(translate(locale, `openrouter.alert.${level}Title`), body + pace)
}

/**
 * Reads OpenRouter usage while its reading is on, for the topbar, the usage cards and the
 * low-balance warnings, and warns once each time the balance reaches a worse level.
 */
export function useOpenRouterUsage(): void {
  const access = useProjectsStore((s) => s.preferences.usageAccess.openrouter)
  const setUsage = useUiStore((s) => s.setOpenRouterUsage)

  useEffect(() => {
    if (!access) {
      lastWarned = 'none'
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const usage = await getCachedOpenRouterUsage()
        if (cancelled) return
        setUsage(usage)
        const level = openRouterAlertLevel(usage)
        if (level === 'none') lastWarned = 'none'
        else if (shouldWarn(lastWarned, level)) {
          lastWarned = level
          warn(level, usage)
        }
      } catch {
        if (!cancelled) setUsage(null)
      }
    }
    const startup = window.setTimeout(() => void tick(), STARTUP_DELAY_MS)
    const interval = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(startup)
      window.clearInterval(interval)
    }
  }, [access, setUsage])
}
