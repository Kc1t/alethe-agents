export type HermesChildSessionObservation = {
  kind: 'durable' | 'live'
  session_id: string
  changed_at_ms: number
}

export type HermesChildSessionDecision = {
  durableSessionId?: string
  nextLiveHandle: string | null
  requestDatabase: boolean
}

const DURABLE_HERMES_SESSION_ID = /^\d{8}_\d{6}_[A-Za-z0-9-]+$/
const LIVE_HERMES_SESSION_HANDLE = /^[A-Fa-f0-9]{8}$/

export function hermesSessionsNearTransition<T extends { started_at_ms: number }>(
  sessions: T[],
  changedAtMs: number | null,
  transitionWindowMs = 10_000,
): T[] {
  if (!changedAtMs || !Number.isFinite(changedAtMs) || changedAtMs <= 0) return []
  return sessions.filter(
    (candidate) => Math.abs(candidate.started_at_ms - changedAtMs) <= transitionWindowMs,
  )
}

export function decideHermesChildSessionObservation(
  previousLiveHandle: string | null,
  observation: HermesChildSessionObservation | null,
): HermesChildSessionDecision {
  if (observation?.kind === 'durable' && DURABLE_HERMES_SESSION_ID.test(observation.session_id)) {
    return {
      durableSessionId: observation.session_id,
      nextLiveHandle: null,
      requestDatabase: false,
    }
  }
  if (observation?.kind === 'live' && LIVE_HERMES_SESSION_HANDLE.test(observation.session_id)) {
    return {
      nextLiveHandle: observation.session_id,
      requestDatabase: observation.session_id !== previousLiveHandle,
    }
  }
  return {
    nextLiveHandle: previousLiveHandle,
    requestDatabase: false,
  }
}
