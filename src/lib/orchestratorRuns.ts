import type { OrchestratorJob, OrchestratorPlanner } from './tauri'

export type RunLane = 'blocked' | 'running' | 'queued' | 'interrupted' | 'failed' | 'finished'

export const RUN_LANE_ORDER: RunLane[] = [
  'blocked',
  'running',
  'queued',
  'interrupted',
  'failed',
  'finished',
]

export const LANE_OF: Record<OrchestratorJob['status'], RunLane> = {
  blocked: 'blocked',
  running: 'running',
  queued: 'queued',
  interrupted: 'interrupted',
  failed: 'failed',
  done: 'finished',
  cancelled: 'finished',
  released: 'finished',
}

// Worst-first: a blocked worker leads everything because it is stopped on a person and still
// holding its slot, a run with a failure reads as failed even while other workers still run, and an
// interrupted worker outranks the live ones because only the user can bring it back.
const STATE_PRIORITY: RunLane[] = [
  'blocked',
  'failed',
  'interrupted',
  'running',
  'queued',
  'finished',
]

export type RunCounts = Record<RunLane, number>

export type OrchestratorRun = {
  id: string
  label: string
  jobs: OrchestratorJob[]
  counts: RunCounts
  state: RunLane
}

export function emptyCounts(): RunCounts {
  return { blocked: 0, running: 0, queued: 0, interrupted: 0, failed: 0, finished: 0 }
}

export function countLanes(jobs: OrchestratorJob[]): RunCounts {
  const counts = emptyCounts()
  for (const job of jobs) counts[LANE_OF[job.status]] += 1
  return counts
}

export function worstState(counts: RunCounts): RunLane {
  return STATE_PRIORITY.find((lane) => counts[lane] > 0) ?? 'finished'
}

export type AttentionLane = Extract<RunLane, 'blocked' | 'failed' | 'interrupted'>

// The lanes nothing but a person can clear, worst first. Blocked leads: a failure is already over,
// a blocked worker is still costing a slot.
const ATTENTION_PRIORITY: AttentionLane[] = ['blocked', 'failed', 'interrupted']

export type Attention = { lane: AttentionLane; count: number }

/** What to say about work that is waiting on the user, or null when nothing is. */
export function attentionOf(counts: RunCounts): Attention | null {
  const lane = ATTENTION_PRIORITY.find((entry) => counts[entry] > 0)
  return lane ? { lane, count: counts[lane] } : null
}

export function groupRuns(jobs: OrchestratorJob[]): OrchestratorRun[] {
  const order: string[] = []
  const grouped = new Map<string, OrchestratorJob[]>()

  for (const job of jobs) {
    const existing = grouped.get(job.runId)
    if (existing) {
      existing.push(job)
      continue
    }
    order.push(job.runId)
    grouped.set(job.runId, [job])
  }

  return order.map((runId) => {
    const runJobs = grouped.get(runId) ?? []
    const counts = countLanes(runJobs)
    const labelled = runJobs.find((job) => (job.runLabel ?? '').trim().length > 0)
    return {
      id: runId,
      label: labelled?.runLabel?.trim() || runId,
      jobs: runJobs,
      counts,
      state: worstState(counts),
    }
  })
}

/**
 * A tab on the board: the agent terminal that asked for the work, with every run it started.
 * `id`/`label`/`agent` are null when the delegation came from outside a terminal.
 */
export type PlannerGroup = {
  id: string | null
  label: string | null
  agent: string | null
  runs: OrchestratorRun[]
  jobs: OrchestratorJob[]
  counts: RunCounts
  state: RunLane
}

// Jobs with no planner bucket under a key no planner id can collide with.
const NO_PLANNER = '\u0000'

function toGroup(
  id: string | null,
  label: string | null,
  agent: string | null,
  jobs: OrchestratorJob[],
): PlannerGroup {
  const counts = countLanes(jobs)
  return { id, label, agent, runs: groupRuns(jobs), jobs, counts, state: worstState(counts) }
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * One group per declared planner, plus one per planner id seen on a job but no longer declared,
 * plus a last group for the jobs that carry no planner at all. The backend sends planners in map
 * order, so declared ones are sorted here to keep the tab strip from reshuffling between snapshots.
 */
export function groupPlanners(
  jobs: OrchestratorJob[],
  planners: OrchestratorPlanner[],
): PlannerGroup[] {
  const buckets = new Map<string, OrchestratorJob[]>()
  for (const job of jobs) {
    const key = job.plannerId ?? NO_PLANNER
    const bucket = buckets.get(key)
    if (bucket) bucket.push(job)
    else buckets.set(key, [job])
  }

  const declared = [...planners].sort(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  )
  const groups = declared.map((planner) =>
    toGroup(
      planner.id,
      clean(planner.label) ?? planner.id,
      clean(planner.agent),
      buckets.get(planner.id) ?? [],
    ),
  )

  const known = new Set(planners.map((planner) => planner.id))
  for (const [key, bucket] of buckets) {
    if (key === NO_PLANNER || known.has(key)) continue
    groups.push(toGroup(key, key, null, bucket))
  }

  const orphans = buckets.get(NO_PLANNER)
  if (orphans) groups.push(toGroup(null, null, null, orphans))

  return groups
}
