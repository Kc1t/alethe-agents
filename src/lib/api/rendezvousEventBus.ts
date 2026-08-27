import { drainRendezvousEvents, type RendezvousEvent } from './syncRendezvous'

/**
 * `drainRendezvousEvents()` removes events from the shared server-side queue as it reads them —
 * it is not a peek. Multiple independent pollers calling it directly (as `ChatTab.tsx`'s
 * chat_contact_ack listener and `ChatPanel.tsx`'s chat_message listener used to, each on their
 * own interval) race for the same events: whichever poller happens to call first "steals" every
 * event that tick, including kinds it doesn't care about and silently discards — a real bug that
 * explained messages vanishing without ever reaching the intended listener. This module is the
 * single place that actually drains the queue, fanning every event out to every subscriber so
 * nothing can be stolen.
 */
type Listener = (events: RendezvousEvent[]) => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | null = null

// Adaptive: poll quickly for a while after any real activity (a subscriber just appeared, or
// something was actually delivered), then back off to a slower idle cadence — instead of a single
// fixed interval that either wastes cycles when idle or feels sluggish for receive latency when
// active. `ACTIVE_WINDOW_MS` after the last activity, `ACTIVE_POLL_MS` is used; otherwise
// `IDLE_POLL_MS`.
const ACTIVE_POLL_MS = 1_200
const IDLE_POLL_MS = 4_000
const ACTIVE_WINDOW_MS = 20_000

let lastActivityAt = 0

function markActivity(): void {
  lastActivityAt = Date.now()
}

function currentIntervalMs(): number {
  return Date.now() - lastActivityAt < ACTIVE_WINDOW_MS ? ACTIVE_POLL_MS : IDLE_POLL_MS
}

async function tick(): Promise<void> {
  if (listeners.size === 0) return
  let events: RendezvousEvent[]
  try {
    events = await drainRendezvousEvents()
  } catch (cause) {
    console.error('[rendezvous-bus] drainRendezvousEvents failed', cause)
    scheduleNext()
    return
  }
  if (events.length > 0) {
    markActivity()
    for (const listener of listeners) {
      try {
        listener(events)
      } catch (cause) {
        console.error('[rendezvous-bus] listener threw', cause)
      }
    }
  }
  scheduleNext()
}

function scheduleNext(): void {
  if (listeners.size === 0) return
  timer = setTimeout(() => void tick(), currentIntervalMs())
}

function maybeStopTimer(): void {
  if (listeners.size > 0 || timer === null) return
  clearTimeout(timer)
  timer = null
}

/** Subscribes to every drained rendezvous event (all kinds — filter in the callback). Runs an
 * immediate drain on subscribe, then repeats on an adaptive interval (faster right after activity,
 * slower when idle — see `ACTIVE_POLL_MS`/`IDLE_POLL_MS`) while at least one subscriber is active.
 * Returns an unsubscribe function. */
export function subscribeToRendezvousEvents(listener: Listener): () => void {
  markActivity()
  const wasRunning = listeners.size > 0
  listeners.add(listener)
  // Only (re)start the single shared poll loop if it wasn't already running — `tick()` reschedules
  // itself via `scheduleNext()`, so starting a second one here would run two loops in parallel.
  if (!wasRunning) void tick()
  return () => {
    listeners.delete(listener)
    maybeStopTimer()
  }
}
