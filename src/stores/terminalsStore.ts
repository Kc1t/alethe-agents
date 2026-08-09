import { create } from 'zustand'

import type { PtyStatus } from '../lib/types'

/**
 * Runtime PTY state — não persistido. Mapeia ptyId → status atual,
 * timestamp da última transição (pra mostrar "há X min" no AgentMonitor)
 * e flag de "tem PTY vivo no backend?".
 *
 * O `status` é derivado por heurística do output (ANSI clear screens,
 * spinners típicos de Claude/Codex etc). Por enquanto só armazena, a
 * inferência vem quando portarmos `agentMonitor.ts`.
 */

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
  /** ms desde última transição de status. Atualizado quando setStatus muda o valor. */
  lastTransitionAt: number
  /** true entre spawn_pty bem-sucedido e pty://exit. */
  alive: boolean
  /** PTY encerrado automaticamente, com sessão/scrollback preservados para retomada. */
  parked: boolean
  /** Nascimento do processo atual, usado pela janela de graça do supervisor. */
  spawnedAt: number
  /** Último input ou output observado pelo frontend. */
  lastIoAt: number
  /**
   * Contador de exit events pendentes de PTYs antigos (após restarts). Cada
   * `beginRestart` incrementa; cada exit event recebido decrementa antes de
   * marcar como exited. Sem isso, o exit do PTY antigo (que chega async após
   * o restart resolver) marca o novo PTY como morto e o overlay "Reiniciar"
   * fica grudado.
   */
  expectedOldExits: number
  lastFocusedAt?: number
  poolState?: 'ACTIVE' | 'HIBERNATING' | 'HIBERNATED' | 'RESTORING' | 'FAILED'
  snapshot?: TerminalSnapshot | null
}

type TerminalsState = {
  byPtyId: Record<string, PtyRuntime>

  reset: () => void
  registerPty: (ptyId: string) => void
  /** Sinaliza que um restart foi iniciado — o próximo exit event será ignorado. */
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
      return {
        byPtyId: {
          ...state.byPtyId,
          [ptyId]: { ...current, lastIoAt: Date.now() },
        },
      }
    }),

  markExited: (ptyId) =>
    set((state) => {
      const current = state.byPtyId[ptyId]
      if (!current) return state
      // Exit pendente de restart anterior — só consome o contador, não marca exited.
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
