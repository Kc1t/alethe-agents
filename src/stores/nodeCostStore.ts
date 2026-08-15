import { create } from 'zustand'

import { getTranscriptCost, type SessionCost } from '../lib/tauri'

   
                                                                           
                                                                                
                                                                               
                                                                              
                                                                                
                                                                        
  
                                                                               
   

type NodeLike = { id: string; transcriptPath: string | null }

type NodeCostState = {
  byNodeId: Record<string, SessionCost>
                                                           
  refresh: (nodes: NodeLike[]) => Promise<void>
  clear: () => void
}

export const useNodeCostStore = create<NodeCostState>((set) => ({
  byNodeId: {},

  refresh: async (nodes) => {
    const targets = nodes.filter((n): n is { id: string; transcriptPath: string } =>
      Boolean(n.transcriptPath),
    )
    if (targets.length === 0) return

    const results = await Promise.all(
      targets.map(async (n) => {
        try {
          const cost = await getTranscriptCost(n.transcriptPath)
          return [n.id, cost] as const
        } catch {
                                                                               
          return null
        }
      }),
    )

    set((state) => {
      const next = { ...state.byNodeId }
      for (const r of results) if (r) next[r[0]] = r[1]
      return { byNodeId: next }
    })
  },

  clear: () => set({ byNodeId: {} }),
}))

                                                                       
export function selectNodeCostTotals(byNodeId: Record<string, SessionCost>): {
  costUsd: number
  totalTokens: number
} {
  let costUsd = 0
  let totalTokens = 0
  for (const cost of Object.values(byNodeId)) {
    totalTokens += cost.total_tokens
    if (cost.cost_usd != null) costUsd += cost.cost_usd
  }
  return { costUsd, totalTokens }
}
