import { LANE_OF } from './orchestratorRuns'
import { normalizeCwd } from './paths'
import type {
  OrchestratorJob,
  OrchestratorJobStatus,
  OrchestratorPlanner,
} from './tauri/orchestrator'
import type { Project, Terminal } from './types'

export type AgentsPlannerGroup = {
  key: string
  plannerId: string | null
  terminal: Terminal | null
  label: string | null
  agent: string | null
  active: OrchestratorJob[]
  finished: OrchestratorJob[]
}

export type AgentsProjectGroup = {
  key: string
  project: Project | null
  planners: AgentsPlannerGroup[]
  running: number
  waiting: number
  costUsd: number | null
}

export const NO_PROJECT_KEY = '\u0000project'
const NO_PLANNER_KEY = '\u0000planner'

const STATUS_ORDER: Record<OrchestratorJobStatus, number> = {
  blocked: 0,
  running: 1,
  queued: 2,
  interrupted: 3,
  failed: 4,
  done: 5,
  cancelled: 6,
  released: 7,
}

type PlannerLocation = { project: Project; terminal: Terminal }

function indexPlannerTerminals(projects: readonly Project[]): Map<string, PlannerLocation> {
  const byPty = new Map<string, PlannerLocation>()
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (tab.ptyId) byPty.set(tab.ptyId, { project, terminal })
      }
    }
  }
  return byPty
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`)
}

export function projectForCwd(projects: readonly Project[], cwd: string): Project | null {
  if (!cwd.trim()) return null
  const target = normalizeCwd(cwd)
  let best: { project: Project; length: number } | null = null
  for (const project of projects) {
    const roots = [project.defaultCwd, ...project.terminals.map((terminal) => terminal.cwd)]
    for (const root of roots) {
      if (!root?.trim()) continue
      const normalized = normalizeCwd(root)
      if (!isWithin(target, normalized)) continue
      if (!best || normalized.length > best.length) best = { project, length: normalized.length }
    }
  }
  return best?.project ?? null
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function activeTabType(terminal: Terminal | null): string | null {
  if (!terminal) return null
  const tab = terminal.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal.tabs[0]
  return tab?.type ?? null
}

function plannerRank(planner: AgentsPlannerGroup, project: Project | null): number {
  if (planner.terminal && project) {
    const index = project.terminals.findIndex((terminal) => terminal.id === planner.terminal?.id)
    if (index >= 0) return index
  }
  return planner.plannerId ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER
}

export function sumJobCost(jobs: readonly OrchestratorJob[]): number | null {
  const priced = jobs.filter((job) => job.costUsd !== null)
  if (priced.length === 0) return null
  return priced.reduce((total, job) => total + (job.costUsd ?? 0), 0)
}

export function groupAgentJobs(
  jobs: readonly OrchestratorJob[],
  projects: readonly Project[],
  planners: readonly OrchestratorPlanner[],
  activeProjectId: string | null,
): AgentsProjectGroup[] {
  const byPty = indexPlannerTerminals(projects)
  const declared = new Map(planners.map((planner) => [planner.id, planner]))
  const buckets = new Map<
    string,
    { project: Project | null; planners: Map<string, AgentsPlannerGroup>; jobs: OrchestratorJob[] }
  >()

  for (const job of jobs) {
    const located = job.plannerId ? byPty.get(job.plannerId) : undefined
    const project = located?.project ?? projectForCwd(projects, job.cwd)
    const projectKey = project?.id ?? NO_PROJECT_KEY
    let bucket = buckets.get(projectKey)
    if (!bucket) {
      bucket = { project, planners: new Map(), jobs: [] }
      buckets.set(projectKey, bucket)
    }
    bucket.jobs.push(job)

    const plannerKey = job.plannerId ?? NO_PLANNER_KEY
    let planner = bucket.planners.get(plannerKey)
    if (!planner) {
      const terminal = located?.terminal ?? null
      const known = job.plannerId ? declared.get(job.plannerId) : undefined
      planner = {
        key: plannerKey,
        plannerId: job.plannerId,
        terminal,
        label: clean(known?.label),
        agent: activeTabType(terminal) ?? clean(known?.agent),
        active: [],
        finished: [],
      }
      bucket.planners.set(plannerKey, planner)
    }
    if (LANE_OF[job.status] === 'finished') planner.finished.push(job)
    else planner.active.push(job)
  }

  const projectOrder = new Map(projects.map((project, index) => [project.id, index]))
  const rankProject = (key: string) => {
    if (key === NO_PROJECT_KEY) return Number.MAX_SAFE_INTEGER
    if (key === activeProjectId) return -1
    return projectOrder.get(key) ?? Number.MAX_SAFE_INTEGER - 1
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => rankProject(a) - rankProject(b))
    .map(([key, bucket]) => {
      const groupPlanners = [...bucket.planners.values()]
        .map((planner) => ({
          ...planner,
          active: [...planner.active].sort(
            (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
          ),
        }))
        .sort((a, b) => plannerRank(a, bucket.project) - plannerRank(b, bucket.project))
      return {
        key,
        project: bucket.project,
        planners: groupPlanners,
        running: bucket.jobs.filter((job) => job.status === 'running').length,
        waiting: bucket.jobs.filter((job) => job.status === 'blocked').length,
        costUsd: sumJobCost(bucket.jobs),
      }
    })
}
