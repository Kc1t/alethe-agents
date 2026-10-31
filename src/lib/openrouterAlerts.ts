import type { OpenRouterUsage } from './tauri'

/** How close the tightest OpenRouter cap is to running out, from calm to spent. */
export type OpenRouterAlertLevel = 'none' | 'low' | 'critical' | 'empty'

const LEVEL_RANK: Record<OpenRouterAlertLevel, number> = { none: 0, low: 1, critical: 2, empty: 3 }

export const OPENROUTER_LOW_PERCENT = 80
export const OPENROUTER_CRITICAL_PERCENT = 95
/** Days of balance left, at the last week's pace, that count as low and as critical. */
export const OPENROUTER_LOW_DAYS = 3
export const OPENROUTER_CRITICAL_DAYS = 1

export function openRouterAlertLevel(usage: OpenRouterUsage | null): OpenRouterAlertLevel {
  const headline = usage?.headline
  if (!headline) return 'none'
  if (headline.remaining_usd <= 0 || headline.used_percent >= 100) return 'empty'
  const days = usage.days_left
  if (
    headline.used_percent >= OPENROUTER_CRITICAL_PERCENT ||
    (days !== null && days <= OPENROUTER_CRITICAL_DAYS)
  ) {
    return 'critical'
  }
  if (
    headline.used_percent >= OPENROUTER_LOW_PERCENT ||
    (days !== null && days <= OPENROUTER_LOW_DAYS)
  ) {
    return 'low'
  }
  return 'none'
}

/**
 * Whether moving from the level last warned about to `next` deserves a new warning: only a worse
 * level does. Going back to calm (a top-up) re-arms every warning.
 */
export function shouldWarn(lastWarned: OpenRouterAlertLevel, next: OpenRouterAlertLevel): boolean {
  return LEVEL_RANK[next] > LEVEL_RANK[lastWarned]
}

/** Dollars as OpenRouter shows them: cents, and more digits only for sub-cent amounts. */
export function formatUsd(value: number): string {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return `$${value.toFixed(digits)}`
}
