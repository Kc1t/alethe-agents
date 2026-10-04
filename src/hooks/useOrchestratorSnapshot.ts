import { useSyncExternalStore } from 'react'

import { listenOrchestratorJobs, orchestratorJobs, type OrchestratorSnapshot } from '../lib/tauri'

export type OrchestratorSnapshotReading = {
  snapshot: OrchestratorSnapshot
  /** When this reading arrived, so a running worker's clock can advance between readings. */
  receivedAt: number
}

const EMPTY: OrchestratorSnapshotReading = {
  snapshot: { jobs: [], planners: [], running: 0, queued: 0, concurrencyLimit: 0 },
  receivedAt: 0,
}

let reading = EMPTY
const subscribers = new Set<() => void>()
let stop: (() => void) | null = null
// Bumped on every start and stop, so a listener that resolves after its subscription ended is
// dropped instead of leaking.
let generation = 0

function publish(snapshot: OrchestratorSnapshot) {
  reading = { snapshot, receivedAt: Date.now() }
  subscribers.forEach((notify) => notify())
}

function start() {
  const current = ++generation
  void orchestratorJobs()
    .then((snapshot) => {
      if (current === generation) publish(snapshot)
    })
    .catch(() => undefined)
  void listenOrchestratorJobs((snapshot) => {
    if (current === generation) publish(snapshot)
  })
    .then((off) => {
      if (current === generation) stop = off
      else off()
    })
    .catch(() => undefined)
}

function subscribe(notify: () => void) {
  subscribers.add(notify)
  if (subscribers.size === 1) start()
  return () => {
    subscribers.delete(notify)
    if (subscribers.size > 0) return
    generation += 1
    stop?.()
    stop = null
  }
}

/**
 * The orchestrator's jobs, shared by everything that shows them: one listener however many
 * components read it, kept only while something is mounted.
 */
export function useOrchestratorSnapshot(): OrchestratorSnapshotReading {
  return useSyncExternalStore(
    subscribe,
    () => reading,
    () => EMPTY,
  )
}
