import { create } from 'zustand'

import { mcpCapabilities, mcpScan } from '../lib/tauri'
import type { McpAgent, McpAgentSnapshot, McpCapability, McpScope } from '../lib/types'

type RefreshOptions = {
  scope?: McpScope
  repo?: string | null
}

type McpState = {
  scope: McpScope
  repo: string | null
  snapshots: McpAgentSnapshot[]
  capabilities: Partial<Record<McpAgent, McpCapability>>
  loading: boolean
  error: string | null
  loadedAt: number
  setScope: (scope: McpScope) => void
  refresh: (options?: RefreshOptions) => Promise<void>
}

let scanSequence = 0
const inFlightScans = new Map<string, Promise<void>>()

function scanKey(scope: McpScope, repo: string | null): string {
  return `${scope}\0${repo?.trim().toLowerCase() ?? ''}`
}

export const useMcpStore = create<McpState>((set, get) => ({
  scope: 'global',
  repo: null,
  snapshots: [],
  capabilities: {},
  loading: false,
  error: null,
  loadedAt: 0,

  setScope: (scope) => {
    if (get().scope === scope) return
    set({ scope })
    void get().refresh({ scope })
  },

  refresh: async (options) => {
    const scope = options?.scope ?? get().scope
    const repo = options?.repo !== undefined ? options.repo : get().repo
    const key = scanKey(scope, repo)
    const existing = inFlightScans.get(key)
    if (existing) return existing

    const sequence = ++scanSequence
    set({ loading: true, error: null, scope, repo })
    const request = (async () => {
      try {
        const snapshots = await mcpScan(scope, repo)
        if (sequence !== scanSequence) return
        set({ snapshots, loading: false, loadedAt: Date.now() })
      } catch (error) {
        if (sequence !== scanSequence) return
        set({
          snapshots: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      if (Object.keys(get().capabilities).length > 0) return
      try {
        const list = await mcpCapabilities()
        set({
          capabilities: Object.fromEntries(list.map((item) => [item.agent, item])) as Partial<
            Record<McpAgent, McpCapability>
          >,
        })
      } catch {
        // Capabilities are decoration; a failure must not blank the panel.
      }
    })()
    inFlightScans.set(key, request)
    try {
      await request
    } finally {
      if (inFlightScans.get(key) === request) inFlightScans.delete(key)
    }
  },
}))
