import { create } from 'zustand'

import { getActiveSessions } from '../lib/sessionResume'
import { getSessionCost, type SessionCost } from '../lib/tauri'
import { useTerminalsStore } from './terminalsStore'

export type AgentCostEntry = {
  ptyId: string
  agent: string
  sessionId: string
  cwd: string
  cost: SessionCost | null

  updatedAt: number
}

type AgentCostState = {
  byPtyId: Record<string, AgentCostEntry>

  refresh: () => Promise<void>
}

function liveAgentSessions(): Array<{
  ptyId: string
  agent: string
  sessionId: string
  cwd: string
}> {
  const sessions = getActiveSessions()
  const alive = useTerminalsStore.getState().byPtyId
  const out: Array<{ ptyId: string; agent: string; sessionId: string; cwd: string }> = []
  for (const [ptyId, s] of Object.entries(sessions)) {
    if (!alive[ptyId]?.alive) continue
    const sessionId =
      s.agent === 'codex'
        ? s.codexSessionId
        : s.agent === 'opencode'
          ? s.opencodeSessionId
          : s.claudeSessionId
    if (!sessionId) continue
    if (s.agent !== 'claude' && s.agent !== 'codex' && s.agent !== 'opencode') continue
    out.push({ ptyId, agent: s.agent, sessionId, cwd: s.cwd })
  }
  return out
}

export const useAgentCostStore = create<AgentCostState>((set) => ({
  byPtyId: {},

  refresh: async () => {
    const live = liveAgentSessions()
    const liveIds = new Set(live.map((s) => s.ptyId))

    const results = await Promise.all(
      live.map(async (s) => {
        try {
          const cost = await getSessionCost(s.agent, s.cwd, s.sessionId)
          return { ...s, cost, updatedAt: Date.now() } as AgentCostEntry
        } catch {
          return null
        }
      }),
    )

    set((state) => {
      const next: Record<string, AgentCostEntry> = {}

      for (const s of live) {
        const fresh = results.find((r) => r && r.ptyId === s.ptyId) ?? null
        next[s.ptyId] = fresh ??
          state.byPtyId[s.ptyId] ?? {
            ptyId: s.ptyId,
            agent: s.agent,
            sessionId: s.sessionId,
            cwd: s.cwd,
            cost: null,
            updatedAt: 0,
          }
      }
      // Poda PTYs que morreram.
      void liveIds
      return { byPtyId: next }
    })
  },
}))

export function selectCostTotals(state: AgentCostState): {
  costUsd: number
  totalTokens: number
  agents: number
} {
  let costUsd = 0
  let totalTokens = 0
  let agents = 0
  for (const entry of Object.values(state.byPtyId)) {
    agents += 1
    if (entry.cost) {
      totalTokens += entry.cost.total_tokens
      if (entry.cost.cost_usd != null) costUsd += entry.cost.cost_usd
    }
  }
  return { costUsd, totalTokens, agents }
}
