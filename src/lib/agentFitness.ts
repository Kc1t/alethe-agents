import type { TFunction } from './i18n'
import type { AntigravityUsage, ClaudeUsage, CodexUsage } from './tauri/usage'

export type AgentFitness = {
  worst: string
  used: number
  resetsAt: string | null
  plan?: string
  rateLimited: boolean
  /** Per-window utilization percent by label ('5h', 'week', 'opus', ...); the routing gates read these. */
  windows: Record<string, number>
}

type Window = { label: string; used: number; resetsAt: string | null }

function worstOf(windows: Window[]): Window {
  return windows.reduce((worst, window) => (window.used > worst.used ? window : worst))
}

function isoFromMs(ms: number): string | null {
  return ms > 0 ? new Date(ms).toISOString() : null
}

/**
 * Human name of the window a fitness `worst` label stands for; any other label is a model limit.
 * Antigravity labels name its quota buckets, which are not weekly windows.
 */
export function quotaWindowLabel(worst: string, t: TFunction, agent?: string): string {
  if (agent === 'antigravity') return t('orchestrator.quotaWindowBucket', { bucket: worst })
  if (worst === '5h') return t('orchestrator.quotaWindowSession')
  if (worst === 'week') return t('orchestrator.quotaWindowWeekly')
  if (worst === 'opus') return t('orchestrator.quotaWindowOpus')
  return t('orchestrator.quotaWindowModel', { model: worst })
}

export function claudeFitness(usage: ClaudeUsage): AgentFitness {
  const windows: Record<string, number> = {
    '5h': usage.five_hour.utilization,
    week: usage.seven_day.utilization,
    opus: usage.seven_day_opus.utilization,
    ...Object.fromEntries(
      (usage.model_limits ?? []).map((limit) => [limit.model.toLowerCase(), limit.utilization]),
    ),
  }
  const worst = worstOf([
    { label: '5h', used: usage.five_hour.utilization, resetsAt: usage.five_hour.resets_at || null },
    {
      label: 'week',
      used: usage.seven_day.utilization,
      resetsAt: usage.seven_day.resets_at || null,
    },
    {
      label: 'opus',
      used: usage.seven_day_opus.utilization,
      resetsAt: usage.seven_day_opus.resets_at || null,
    },
    ...(usage.model_limits ?? []).map((limit) => ({
      label: limit.model.toLowerCase(),
      used: limit.utilization,
      resetsAt: limit.resets_at || null,
    })),
  ])
  return {
    worst: worst.label,
    used: Math.round(worst.used),
    resetsAt: worst.resetsAt,
    rateLimited: false,
    windows,
  }
}

export function codexFitness(usage: CodexUsage): AgentFitness {
  const windows: Record<string, number> = {
    '5h': usage.primary.used_percent,
    week: usage.secondary.used_percent,
  }
  const worst = worstOf([
    {
      label: '5h',
      used: usage.primary.used_percent,
      resetsAt: isoFromMs(usage.primary.resets_at_ms),
    },
    {
      label: 'week',
      used: usage.secondary.used_percent,
      resetsAt: isoFromMs(usage.secondary.resets_at_ms),
    },
  ])
  return {
    worst: worst.label,
    used: Math.round(worst.used),
    resetsAt: worst.resetsAt,
    plan: usage.plan || undefined,
    rateLimited: usage.rate_limited,
    windows,
  }
}

/**
 * Antigravity meters model groups apart, but the core keeps one reading per vendor, so the tightest
 * bucket stands for all of them. A role on a model with room left can still read as running out.
 */
export function antigravityFitness(usage: AntigravityUsage): AgentFitness {
  const windows: Record<string, number> =
    usage.buckets.length > 0
      ? Object.fromEntries(usage.buckets.map((bucket) => [bucket.label, bucket.used_percent]))
      : { quota: usage.used_percent }
  const worst =
    usage.buckets.length > 0
      ? worstOf(
          usage.buckets.map((bucket) => ({
            label: bucket.label,
            used: bucket.used_percent,
            resetsAt: bucket.resets_at || null,
          })),
        )
      : { label: 'quota', used: usage.used_percent, resetsAt: null }
  return {
    worst: worst.label,
    used: Math.round(worst.used),
    resetsAt: worst.resetsAt,
    rateLimited: usage.rate_limited,
    windows,
  }
}
