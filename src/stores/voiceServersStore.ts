import { create } from 'zustand'

import { voiceServersList } from '../lib/tauri'
import type { VoiceServer } from '../lib/types'

type ServerHealth = 'connected' | 'disconnected' | 'invalid'

type VoiceServersState = {
  servers: VoiceServer[]
  loaded: boolean

  failed: boolean

  health: Record<string, ServerHealth>
  refresh: () => Promise<void>
  setHealth: (id: string, status: ServerHealth) => void
}

export const useVoiceServersStore = create<VoiceServersState>((set) => ({
  servers: [],
  loaded: false,
  failed: false,
  health: {},
  refresh: async () => {
    set({ loaded: false, failed: false, servers: [] })
    try {
      const servers = await voiceServersList()
      set((state) => ({
        servers,
        loaded: true,
        failed: false,
        health: Object.fromEntries(
          Object.entries(state.health).filter(([id]) => servers.some((s) => s.id === id)),
        ),
      }))
    } catch {
      set({ loaded: true, failed: true })
    }
  },
  setHealth: (id, status) => set((state) => ({ health: { ...state.health, [id]: status } })),
}))
