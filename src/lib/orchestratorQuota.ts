import { USAGE_FALLBACK_THRESHOLD, USAGE_POLL_MS } from './agentCanvasConfig'
import { type AgentFitness, claudeFitness, codexFitness } from './agentFitness'
import { getClaudeUsage, getCodexUsage, setAgentFitness } from './tauri'

export type QuotaWarning = {
  agent: 'claude' | 'codex'
  pct: number
  resetsAt: string | null
}

type Listener = (warnings: QuotaWarning[]) => void

export type FitnessReadings = Partial<Record<QuotaWarning['agent'], AgentFitness>>

const listeners = new Set<Listener>()
let latest: QuotaWarning[] = []
// The same readings the core routes by, kept so the routing settings can show them.
let fitness: FitnessReadings = {}
const fitnessListeners = new Set<() => void>()
let users = 0
let timer: number | null = null

async function report(agent: 'claude' | 'codex', reading: AgentFitness) {
  fitness = { ...fitness, [agent]: reading }
  for (const listener of fitnessListeners) listener()
  await setAgentFitness(agent, reading).catch(() => undefined)
  return reading.rateLimited || reading.used >= USAGE_FALLBACK_THRESHOLD
    ? { agent, pct: reading.used, resetsAt: reading.resetsAt }
    : null
}

async function check(): Promise<void> {
  const next: QuotaWarning[] = []
  try {
    const warning = await report('claude', claudeFitness(await getClaudeUsage()))
    if (warning) next.push(warning)
  } catch {
    /* Usage is optional: an agent that cannot report simply gets no warning. */
  }
  try {
    const warning = await report('codex', codexFitness(await getCodexUsage()))
    if (warning) next.push(warning)
  } catch {
    /* Same as above. */
  }
  if (users === 0) return
  latest = next
  for (const listener of listeners) listener(latest)
}

/**
 * Keeps the orchestrator core's fitness reading fresh while anything needs it. The planner reads
 * that reading on every tool call, so it is fed for as long as the orchestrator is on, not only
 * while a board happens to be open. Returns the release function.
 */
export function acquireQuotaPolling(): () => void {
  users += 1
  if (users === 1) {
    void check()
    timer = window.setInterval(() => void check(), USAGE_POLL_MS)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    users -= 1
    if (users === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }
}

export function subscribeQuotaWarnings(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function currentQuotaWarnings(): QuotaWarning[] {
  return latest
}

export function subscribeFitness(listener: () => void): () => void {
  fitnessListeners.add(listener)
  return () => fitnessListeners.delete(listener)
}

/** How used each provider is, as last read; empty until the first reading comes back. */
export function currentFitness(): FitnessReadings {
  return fitness
}
