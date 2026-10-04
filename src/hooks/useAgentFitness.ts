import { useSyncExternalStore } from 'react'

import {
  acquireQuotaPolling,
  currentFitness,
  type FitnessReadings,
  subscribeFitness,
} from '../lib/orchestratorQuota'

const NONE: FitnessReadings = {}

function subscribe(notify: () => void) {
  // Reading usage is what keeps it fresh: polling runs for as long as something shows it.
  const release = acquireQuotaPolling()
  const off = subscribeFitness(notify)
  return () => {
    off()
    release()
  }
}

/** Each provider's current usage, the same reading the orchestrator routes by. */
export function useAgentFitness(): FitnessReadings {
  return useSyncExternalStore(subscribe, currentFitness, () => NONE)
}
