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
let timer: ReturnType<typeof setInterval> | null = null
const POLL_INTERVAL_MS = 4_000

async function tick(): Promise<void> {
  if (listeners.size === 0) return
  let events: RendezvousEvent[]
  try {
    events = await drainRendezvousEvents()
  } catch (cause) {
    console.error('[rendezvous-bus] drainRendezvousEvents failed', cause)
    return
  }
  if (events.length === 0) return
  for (const listener of listeners) {
    try {
      listener(events)
    } catch (cause) {
      console.error('[rendezvous-bus] listener threw', cause)
    }
  }
}

function ensureTimer(): void {
  if (timer !== null) return
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS)
}

function maybeStopTimer(): void {
  if (listeners.size > 0 || timer === null) return
  clearInterval(timer)
  timer = null
}

/** Subscribes to every drained rendezvous event (all kinds — filter in the callback). Runs an
 * immediate drain on subscribe, then every `POLL_INTERVAL_MS` while at least one subscriber is
 * active. Returns an unsubscribe function. */
export function subscribeToRendezvousEvents(listener: Listener): () => void {
  listeners.add(listener)
  ensureTimer()
  void tick()
  return () => {
    listeners.delete(listener)
    maybeStopTimer()
  }
}
