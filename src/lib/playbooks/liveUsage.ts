import type { ClaudeUsage, CodexUsage } from '../tauri/usage'
import type { ProviderUsage, Usage } from './catalog'

function hoursUntil(at: number, now: number): number | null {
  return Number.isFinite(at) && at > now ? Math.max(1, Math.ceil((at - now) / 3_600_000)) : null
}

export function claudeLiveUsage(usage: ClaudeUsage, now = Date.now()): ProviderUsage {
  return {
    short: Math.round(usage.five_hour.utilization),
    week: Math.round(usage.seven_day.utilization),
    opus: Math.round(usage.seven_day_opus.utilization),
    reset: hoursUntil(Date.parse(usage.seven_day.resets_at), now),
    expires: null,
  }
}

export function codexLiveUsage(usage: CodexUsage, now = Date.now()): ProviderUsage {
  return {
    short: Math.round(usage.primary.used_percent),
    week: Math.round(usage.secondary.used_percent),
    reset: usage.secondary.resets_at_ms > 0 ? hoursUntil(usage.secondary.resets_at_ms, now) : null,
    expires: null,
  }
}

export async function readLiveUsage(readers: {
  claude?: () => Promise<ClaudeUsage>
  codex?: () => Promise<CodexUsage>
}): Promise<Usage> {
  const [claude, codex] = await Promise.allSettled([
    readers.claude?.() ?? Promise.reject(new Error('off')),
    readers.codex?.() ?? Promise.reject(new Error('off')),
  ])
  const live: Usage = {}
  if (claude.status === 'fulfilled') live.claude = claudeLiveUsage(claude.value)
  if (codex.status === 'fulfilled') live.codex = codexLiveUsage(codex.value)
  return live
}
