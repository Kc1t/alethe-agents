import { useEffect, useState } from 'react'

import { USAGE_FALLBACK_THRESHOLD, USAGE_POLL_MS } from '../lib/agentCanvasConfig'
import { getClaudeUsage, getCodexUsage } from '../lib/tauri'

export type QuotaWarning = {
  agent: 'claude' | 'codex'
  pct: number
  resetsAt: string | null
}

export function useOrchestratorQuotaWarnings(): QuotaWarning[] {
  const [warnings, setWarnings] = useState<QuotaWarning[]>([])

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      const next: QuotaWarning[] = []
      try {
        const usage = await getClaudeUsage()
        if (usage.five_hour.utilization >= USAGE_FALLBACK_THRESHOLD) {
          next.push({ agent: 'claude', pct: Math.round(usage.five_hour.utilization), resetsAt: usage.five_hour.resets_at })
        }
      } catch {
        // ignore
      }
      try {
        const usage = await getCodexUsage()
        if (usage.primary.used_percent >= USAGE_FALLBACK_THRESHOLD) {
          next.push({
            agent: 'codex',
            pct: Math.round(usage.primary.used_percent),
            resetsAt: usage.primary.resets_at_ms > 0 ? new Date(usage.primary.resets_at_ms).toISOString() : null,
          })
        }
      } catch {
        // ignore
      }
      if (!cancelled) setWarnings(next)
    }

    void check()
    const timer = window.setInterval(check, USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return warnings
}
