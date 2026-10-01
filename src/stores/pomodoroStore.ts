import { create } from 'zustand'

import { getLocale, translate } from '../lib/i18n'
import { notifyPomodoro } from '../lib/notifications'
import type { PomodoroPhase, PomodoroSessionSnapshot, PomodoroStatus } from '../lib/types'
import { useProjectsStore } from './projectsStore'

/**
 * Standalone store for the Pomodoro timer — modeled on mergeStore.ts: its own
 * phase/status union, a module-level `setInterval` singleton (not a component
 * `useEffect`), and it reaches into `useProjectsStore` for the configured
 * durations and to persist a resumable snapshot, instead of merging into
 * projectsStore itself.
 *
 * The store never writes its countdown to state every second — only phase
 * transitions (start/pause/resume/reset/finish) touch `set`/persistence.
 * Remaining time is derived from `endsAt` by each consuming component on its
 * own 1s interval, so this store change never causes UI-wide re-renders.
 */

const CYCLES_PER_LONG_BREAK = 4

function t(key: Parameters<typeof translate>[1], params?: Record<string, string | number>) {
  return translate(getLocale(), key, params)
}

function durationMinutesFor(phase: PomodoroPhase): number {
  const prefs = useProjectsStore.getState().preferences
  if (phase === 'work') return prefs.pomodoroWorkMinutes
  if (phase === 'longBreak') return prefs.pomodoroLongBreakMinutes
  return prefs.pomodoroShortBreakMinutes
}

export type PomodoroState = {
  phase: PomodoroPhase
  status: PomodoroStatus
  /** Epoch ms the current phase ends at. Only set while running. */
  endsAt: number | null
  /** Frozen remaining time, only set while paused. */
  remainingMsAtPause: number | null
  cyclesCompleted: number
  focusTodoId: string | null

  /** Starts the given phase, or infers the next one from the current state
   *  when omitted (idle/break-finished → work; work-finished → short or long
   *  break depending on the cycle cadence). */
  start: (phase?: PomodoroPhase) => void
  pause: () => void
  resume: () => void
  reset: () => void
  setFocusTodo: (id: string | null) => void
}

function persistSnapshot(state: PomodoroState) {
  const snapshot: PomodoroSessionSnapshot | null =
    state.status === 'idle'
      ? null
      : {
          phase: state.phase,
          status: state.status,
          endsAt: state.endsAt,
          remainingMsAtPause: state.remainingMsAtPause,
          cyclesCompleted: state.cyclesCompleted,
          focusTodoId: state.focusTodoId,
        }
  useProjectsStore.getState().setPreferences({ pomodoroSession: snapshot })
}

function hydrateFromPreferences(): Pick<
  PomodoroState,
  'phase' | 'status' | 'endsAt' | 'remainingMsAtPause' | 'cyclesCompleted' | 'focusTodoId'
> {
  const session = useProjectsStore.getState().preferences.pomodoroSession
  if (!session) {
    return {
      phase: 'idle',
      status: 'idle',
      endsAt: null,
      remainingMsAtPause: null,
      cyclesCompleted: 0,
      focusTodoId: null,
    }
  }
  // The phase's real end time already passed while the app was closed —
  // surface it as finished (waiting for a manual "start next") instead of
  // silently resuming a session with negative remaining time.
  if (session.status === 'running' && session.endsAt !== null && session.endsAt <= Date.now()) {
    return { ...session, status: 'finished', endsAt: null }
  }
  return { ...session }
}

let tickerId: ReturnType<typeof setInterval> | null = null

function stopTicker() {
  if (tickerId === null) return
  clearInterval(tickerId)
  tickerId = null
}

function checkFinished() {
  const state = usePomodoroStore.getState()
  if (state.status !== 'running' || state.endsAt === null) return
  if (Date.now() < state.endsAt) return

  stopTicker()
  const finishedPhase = state.phase
  const cyclesCompleted =
    finishedPhase === 'work' ? state.cyclesCompleted + 1 : state.cyclesCompleted
  usePomodoroStore.setState({ status: 'finished', endsAt: null, cyclesCompleted })
  persistSnapshot(usePomodoroStore.getState())

  void notifyPomodoro(
    finishedPhase === 'work'
      ? t('pomodoro.notifyWorkDoneTitle')
      : t('pomodoro.notifyBreakDoneTitle'),
    finishedPhase === 'work' ? t('pomodoro.notifyWorkDoneBody') : t('pomodoro.notifyBreakDoneBody'),
  )
}

function ensureTicker() {
  if (tickerId !== null) return
  tickerId = setInterval(checkFinished, 1000)
}

export const usePomodoroStore = create<PomodoroState>((set, get) => ({
  ...hydrateFromPreferences(),

  start: (explicitPhase) => {
    const state = get()
    let phase = explicitPhase
    if (!phase) {
      if (state.phase === 'work') {
        phase =
          state.cyclesCompleted > 0 && state.cyclesCompleted % CYCLES_PER_LONG_BREAK === 0
            ? 'longBreak'
            : 'shortBreak'
      } else {
        phase = 'work'
      }
    }
    const endsAt = Date.now() + durationMinutesFor(phase) * 60_000
    set({ phase, status: 'running', endsAt, remainingMsAtPause: null })
    persistSnapshot(get())
    ensureTicker()
  },

  pause: () => {
    const state = get()
    if (state.status !== 'running' || state.endsAt === null) return
    const remaining = Math.max(0, state.endsAt - Date.now())
    stopTicker()
    set({ status: 'paused', remainingMsAtPause: remaining, endsAt: null })
    persistSnapshot(get())
  },

  resume: () => {
    const state = get()
    if (state.status !== 'paused' || state.remainingMsAtPause === null) return
    set({
      status: 'running',
      endsAt: Date.now() + state.remainingMsAtPause,
      remainingMsAtPause: null,
    })
    persistSnapshot(get())
    ensureTicker()
  },

  reset: () => {
    stopTicker()
    set({
      phase: 'idle',
      status: 'idle',
      endsAt: null,
      remainingMsAtPause: null,
      cyclesCompleted: 0,
      focusTodoId: null,
    })
    persistSnapshot(get())
  },

  setFocusTodo: (id) => {
    set({ focusTodoId: id })
    persistSnapshot(get())
  },
}))

if (usePomodoroStore.getState().status === 'running') ensureTicker()

// `projectsStore` reads its persisted preferences from disk asynchronously (Tauri IPC) — by the
// time this module evaluates, `hydrateFromPreferences()` above almost certainly ran before that
// finished, so it only ever saw the default (empty) preferences. Re-apply the real snapshot once
// projectsStore's own hydration completes, but only if nothing already started a fresh session
// in the meantime (avoids clobbering a session the user just started with stale disk data).
useProjectsStore.subscribe((state, prevState) => {
  if (!state.hydrated || prevState.hydrated) return
  if (usePomodoroStore.getState().status !== 'idle') return
  const hydrated = hydrateFromPreferences()
  usePomodoroStore.setState(hydrated)
  if (hydrated.status === 'running') ensureTicker()
})
