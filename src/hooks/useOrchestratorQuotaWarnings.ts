import { useEffect, useState } from 'react'

import { type AgentFitness, claudeFitness, codexFitness } from '../lib/agentFitness'
import { USAGE_FALLBACK_THRESHOLD, USAGE_POLL_MS } from '../lib/agentCanvasConfig'
import { getClaudeUsage, getCodexUsage, setAgentFitness } from '../lib/tauri'

export type QuotaWarning = {
  agent: 'claude' | 'codex'
  pct: number
  resetsAt: string | null
}

export function useOrchestratorQuotaWarnings(): QuotaWarning[] {
  const [warnings, setWarnings] = useState<QuotaWarning[]>([])

  useEffect(() => {
    let cancelled = false

    const report = async (agent: 'claude' | 'codex', fitness: AgentFitness) => {
      await setAgentFitness(agent, fitness).catch(() => undefined)
      return fitness.rateLimited || fitness.used >= USAGE_FALLBACK_THRESHOLD
        ? { agent, pct: fitness.used, resetsAt: fitness.resetsAt }
        : null
    }

    const check = async () => {
      const next: QuotaWarning[] = []
      try {
        const warning = await report('claude', claudeFitness(await getClaudeUsage()))
        if (warning) next.push(warning)
      } catch {
        // ignore
      }
      try {
        const warning = await report('codex', codexFitness(await getCodexUsage()))
        if (warning) next.push(warning)
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
