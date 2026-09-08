import { create } from 'zustand'

import type { PtyStatus } from '../lib/types'

export const IO_TIMESTAMP_THROTTLE_MS = 250

export type TerminalSnapshot = {
  ansiBuffer: string
  scrollTop: number
  options: Record<string, any>
  cursor?: { col: number; row: number }
  selection?: string
}

export type PtyRuntime = {
  ptyId: string
  status: PtyStatus

  lastTransitionAt: number

  alive: boolean

  parked: boolean

  spawnedAt: number

  lastIoAt: number

  expectedOldExits: number
  lastFocusedAt?: number
  poolState?: 'ACTIVE' | 'HIBERNATING' | 'HIBERNATED' | 'RESTORING' | 'FAILED'
  snapshot?: TerminalSnapshot | null
}

type TerminalsState = {
  byPtyId: Record<string, PtyRuntime>

  reset: () => void
  registerPty: (ptyId: string) => void

  beginRestart: (ptyId: string) => void
  setStatus: (ptyId: string, status: PtyStatus) => void
  recordIo: (ptyId: string) => void
  markExited: (ptyId: string) => void
  markSuspended: (ptyId: string) => void
  unregister: (ptyId: string) => void
  focusPty: (ptyId: string) => void
  setSnapshot: (ptyId: string, snapshot: TerminalSnapshot | null) => void
  setPoolState: (ptyId: string, poolState: PtyRuntime['poolState']) => void
}

function emptyRuntime(ptyId: string): PtyRuntime {
  const now = Date.now()
  return {
    ptyId,
    status: 'waiting',
    lastTransitionAt: now,
    alive: true,
    parked: false,
    spawnedAt: now,
    lastIoAt: now,
    expectedOldExits: 0,
    lastFocusedAt: Date.now(),
    poolState: 'ACTIVE',
    snapshot: null,
  }
}

export const useTerminalsStore = create<TerminalsState>((set) => ({
  byPtyId: {},

  reset: () => set({ byPtyId: {} }),

  registerPty: (ptyId) =>
    set((state) => {
      if (state.byPtyId[ptyId]?.alive) return state
      return { byPtyId: { ...state.byPtyId, [ptyId]: emptyRuntime(ptyId) } }
    }),

  beginRestart: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      const base = current ?? emptyRuntime(ptyId)
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: {
            ...base,
            alive: true,
            parked: false,
            status: 'waiting',
            lastTransitionAt: Date.now(),
            spawnedAt: Date.now(),
            lastIoAt: Date.now(),
            expectedOldExits: base.expectedOldExits + 1,
            poolState: 'ACTIVE',
            snapshot: null,
          },
        },
      }
    }),

  setStatus: (ptyId, status) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current || current.status === status) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, status, lastTransitionAt: Date.now() },
        },
      }
    }),

  recordIo: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      const now = Date.now()
      if (now - current.lastIoAt < IO_TIMESTAMP_THROTTLE_MS) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, lastIoAt: now },
        },
      }
    }),

  markExited: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state

      if (current.expectedOldExits > 0) {
        return {
          byPtyId: {
            ...state.byPtyId,
            [ptyId]: { ...current, expectedOldExits: current.expectedOldExits - 1 },
          },
        }
      }
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: {
            ...current,
            alive: false,
            parked: false,
            status: 'stopped',
            lastTransitionAt: Date.now(),
          },
        },
      }
    }),

  markSuspended: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: {
            ...current,
            alive: false,
            parked: true,
            status: 'stopped',
            lastTransitionAt: Date.now(),
            poolState: 'ACTIVE',
            snapshot: null,
          },
        },
      }
    }),

  unregister: (ptyId) =>
    set((state) => {
      if (!(ptyId in state.byPtyId)) return state
      const next = { ...state.byPtyId }
      delete next[ptyId]
      return { byPtyId: next }
    }),

  focusPty: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, lastFocusedAt: Date.now() },
        },
      }
    }),

  setSnapshot: (ptyId, snapshot) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, snapshot },
        },
      }
    }),

  setPoolState: (ptyId, poolState) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, poolState },
        },
      }
    }),
}))
