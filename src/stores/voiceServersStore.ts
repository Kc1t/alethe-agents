import { create } from 'zustand'

import { voiceServersList } from '../lib/tauri'
import type { VoiceServer } from '../lib/types'

type ServerHealth = 'connected' | 'disconnected' | 'invalid'

type VoiceServersState = {
  servers: VoiceServer[]
  loaded: boolean
  /** The last listing failed: the list is unknown, not empty. */
  failed: boolean
  /** Last connection test per server in this session. */
  health: Record<string, ServerHealth>
  refresh: () => Promise<void>
  setHealth: (id: string, status: ServerHealth) => void
}

/** The active profile's local voice servers, read from the backend (which owns the list). */
export const useVoiceServersStore = create<VoiceServersState>((set) => ({
  servers: [],
  loaded: false,
  failed: false,
  health: {},
  refresh: async () => {
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
