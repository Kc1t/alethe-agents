import { describe, expect, it } from 'vitest'

import { formatUsd, openRouterAlertLevel, shouldWarn } from './openrouterAlerts'
import type { OpenRouterUsage } from './tauri'

function usage(used: number, remaining: number, daysLeft: number | null = null): OpenRouterUsage {
  return {
    status: 'ready',
    has_api_key: true,
    has_management_key: true,
    key_error: null,
    management_error: null,
    account: null,
    key: null,
    budget: null,
    activity: null,
    headline: { source: 'account', used_percent: used, remaining_usd: remaining, total_usd: 100 },
    daily_burn_usd: daysLeft === null ? null : remaining / daysLeft,
    days_left: daysLeft,
  }
}

describe('openRouterAlertLevel', () => {
  it('is calm without a known cap', () => {
    expect(openRouterAlertLevel(null)).toBe('none')
    expect(openRouterAlertLevel({ ...usage(0, 0), headline: null })).toBe('none')
  })

  it('rises with the share of the balance used', () => {
    expect(openRouterAlertLevel(usage(50, 50))).toBe('none')
    expect(openRouterAlertLevel(usage(80, 20))).toBe('low')
    expect(openRouterAlertLevel(usage(96, 4))).toBe('critical')
    expect(openRouterAlertLevel(usage(100, 0))).toBe('empty')
  })

  it('also rises when the pace leaves only a few days', () => {
    expect(openRouterAlertLevel(usage(40, 60, 2.5))).toBe('low')
    expect(openRouterAlertLevel(usage(40, 60, 0.5))).toBe('critical')
    expect(openRouterAlertLevel(usage(40, 60, 20))).toBe('none')
  })
})

describe('shouldWarn', () => {
  it('warns only on a worse level, and again after a top-up', () => {
    expect(shouldWarn('none', 'low')).toBe(true)
    expect(shouldWarn('low', 'low')).toBe(false)
    expect(shouldWarn('low', 'critical')).toBe(true)
    expect(shouldWarn('critical', 'low')).toBe(false)
    expect(shouldWarn('none', 'none')).toBe(false)
  })
})

describe('formatUsd', () => {
  it('shows cents, and sub-cent amounts with more digits', () => {
    expect(formatUsd(12.5)).toBe('$12.50')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
