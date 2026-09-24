import type { ClaudeUsage, CodexUsage } from './tauri/usage'

export type AgentFitness = {
  worst: string
  used: number
  resetsAt: string | null
  plan?: string
  rateLimited: boolean
}

type Window = { label: string; used: number; resetsAt: string | null }

function worstOf(windows: Window[]): Window {
  return windows.reduce((worst, window) => (window.used > worst.used ? window : worst))
}

function isoFromMs(ms: number): string | null {
  return ms > 0 ? new Date(ms).toISOString() : null
}

export function claudeFitness(usage: ClaudeUsage): AgentFitness {
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
  ])
  return {
    worst: worst.label,
    used: Math.round(worst.used),
    resetsAt: worst.resetsAt,
    rateLimited: false,
  }
}

export function codexFitness(usage: CodexUsage): AgentFitness {
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
  }
}
