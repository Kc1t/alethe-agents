import { create } from 'zustand'

import type { JevDecision } from '../lib/tauri'
import type { VoicePlan, VoiceWarning } from '../lib/voiceCommand'

export type VoiceHistoryStatus = 'deciding' | 'ran' | 'waiting' | 'blocked' | 'failed'

export interface VoiceHistoryEntry {
  id: string
  at: number
  spoken: string
  source: 'voice' | 'typed'
  status: VoiceHistoryStatus
  summary: string
  decision: JevDecision | null
  plan: VoicePlan | null
  warnings: VoiceWarning[]
  error: string | null
  transcribeMs: number | null
  decideMs: number | null
  actions: string[]
}

interface VoiceHistoryState {
  entries: VoiceHistoryEntry[]
  start: (spoken: string, source: 'voice' | 'typed', summary: string) => string
  settle: (id: string, patch: Partial<Omit<VoiceHistoryEntry, 'id' | 'at'>>) => void
  clear: () => void
}

const LIMIT = 50

export const useVoiceHistoryStore = create<VoiceHistoryState>((set) => ({
  entries: [],
  start: (spoken, source, summary) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const entry: VoiceHistoryEntry = {
      id,
      at: Date.now(),
      spoken,
      source,
      status: 'deciding',
      summary,
      decision: null,
      plan: null,
      warnings: [],
      error: null,
      transcribeMs: null,
      decideMs: null,
      actions: [],
    }
    set((state) => ({ entries: [entry, ...state.entries].slice(0, LIMIT) }))
    return id
  },
  settle: (id, patch) =>
    set((state) => ({
      entries: state.entries.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  clear: () => set({ entries: [] }),
}))
