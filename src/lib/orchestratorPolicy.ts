import {
  AGENT_EFFORT_LEVELS,
  DEFAULT_ORCHESTRATOR_POLICY,
  DEFAULT_ORCHESTRATOR_ROUTING,
  ORCHESTRATION_TABS,
  type OrchestrationTabId,
  ORCHESTRATOR_MAX_KEPT_FINISHED,
  ORCHESTRATOR_MAX_ROUTES,
  ORCHESTRATOR_ROUTING_PRESETS,
  ORCHESTRATOR_TIMEOUT_CHOICES,
  type OrchestratorPolicyPreferences,
  type OrchestratorRoute,
  type OrchestratorRoutingPreferences,
  type OrchestratorRoutingPreset,
  type OrchestratorTaskComplexity,
} from './types'

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

const COMPLEXITIES: readonly OrchestratorTaskComplexity[] = ['light', 'standard', 'deep']

function clampPercent(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : fallback
}

function normalizeRoute(raw: unknown, fallback: OrchestratorRoute): OrchestratorRoute {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<OrchestratorRoute>
  const hasModel = typeof source.model === 'string'
  const model = typeof source.model === 'string' ? source.model.trim() : ''
  const effort = pick(source.effort, AGENT_EFFORT_LEVELS, fallback.effort ?? 'medium')
  const agent = pick(source.agent, ['claude', 'codex'], fallback.agent)
  // A preset's model belongs to the preset's provider: a route on the other CLI must not inherit it.
  const inherited = agent === fallback.agent ? fallback.model : undefined
  return {
    agent,
    ...(hasModel ? { model } : inherited ? { model: inherited } : {}),
    ...(effort ? { effort } : {}),
  }
}

/**
 * A tier's routes, in the order they are tried. Preferences saved before a tier could chain more
 * than two routes hold `{ primary, fallback }`, which reads as a list of two.
 */
function normalizeRoutes(raw: unknown, preset: readonly OrchestratorRoute[]): OrchestratorRoute[] {
  const legacy = raw as { primary?: unknown; fallback?: unknown } | null | undefined
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : legacy && typeof legacy === 'object' && (legacy.primary || legacy.fallback)
      ? [legacy.primary, legacy.fallback]
      : []
  const routes: OrchestratorRoute[] = []
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    // Two identical routes are left alone: dropping one here would make a row vanish while the
    // person is still editing it into something else.
    routes.push(normalizeRoute(entry, preset[index] ?? preset[preset.length - 1]))
  })
  // A tier with no route could never place a task.
  return routes.length > 0 ? routes.slice(0, ORCHESTRATOR_MAX_ROUTES) : [...preset]
}

export function normalizeOrchestratorRouting(raw: unknown): OrchestratorRoutingPreferences {
  const source = (
    raw && typeof raw === 'object' ? raw : {}
  ) as Partial<OrchestratorRoutingPreferences>
  const preset = pick<OrchestratorRoutingPreset>(
    source.preset,
    ['economy', 'balanced', 'quality', 'custom'],
    DEFAULT_ORCHESTRATOR_ROUTING.preset,
  )
  const presetBase =
    preset === 'custom'
      ? ORCHESTRATOR_ROUTING_PRESETS.balanced
      : ORCHESTRATOR_ROUTING_PRESETS[preset]
  const rawTiers: Partial<Record<OrchestratorTaskComplexity, unknown>> =
    source.tiers && typeof source.tiers === 'object' ? source.tiers : {}
  const tiers = Object.fromEntries(
    COMPLEXITIES.map((complexity) => [
      complexity,
      normalizeRoutes(rawTiers[complexity], presetBase.tiers[complexity]),
    ]),
  ) as OrchestratorRoutingPreferences['tiers']
  let watchPercent = clampPercent(source.watchPercent, presetBase.watchPercent)
  let protectPercent = clampPercent(source.protectPercent, presetBase.protectPercent)
  let criticalPercent = clampPercent(source.criticalPercent, presetBase.criticalPercent)
  protectPercent = Math.max(watchPercent + 1, protectPercent)
  criticalPercent = Math.max(protectPercent + 1, criticalPercent)
  if (criticalPercent > 100) {
    criticalPercent = 100
    protectPercent = Math.min(protectPercent, 99)
    watchPercent = Math.min(watchPercent, protectPercent - 1)
  }
  return { preset, watchPercent, protectPercent, criticalPercent, tiers }
}

/** The sub-tab order as saved, without ids this version does not have and with any it gained. */
export function normalizeOrchestrationTabOrder(raw: unknown): OrchestrationTabId[] {
  const saved = Array.isArray(raw) ? raw : []
  const known = saved.filter(
    (id, index): id is OrchestrationTabId =>
      ORCHESTRATION_TABS.includes(id as OrchestrationTabId) && saved.indexOf(id) === index,
  )
  return [...known, ...ORCHESTRATION_TABS.filter((id) => !known.includes(id))]
}

/**
 * Persisted preferences can be hand-edited or synced from another version. Anything unrecognised
 * falls back to that rule's default, so a value from a newer version never turns into a looser rule.
 */
export function normalizeOrchestratorPolicy(raw: unknown): OrchestratorPolicyPreferences {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof OrchestratorPolicyPreferences, unknown>
  >
  const fallback = DEFAULT_ORCHESTRATOR_POLICY
  const timeout = Number(source.timeoutMinutes)
  const kept = typeof source.keepFinished === 'number' ? Math.round(source.keepFinished) : NaN
  return {
    defaultAgent: pick(source.defaultAgent, ['auto', 'claude', 'codex'], fallback.defaultAgent),
    timeoutMinutes: ORCHESTRATOR_TIMEOUT_CHOICES.includes(timeout)
      ? timeout
      : fallback.timeoutMinutes,
    approvals: pick(source.approvals, ['planner', 'always', 'never'], fallback.approvals),
    isolation: pick(source.isolation, ['planner', 'always'], fallback.isolation),
    webSearch: pick(source.webSearch, ['planner', 'never'], fallback.webSearch),
    keepFinished: Number.isFinite(kept)
      ? Math.min(ORCHESTRATOR_MAX_KEPT_FINISHED, Math.max(0, kept))
      : fallback.keepFinished,
    codexSandbox: pick(
      source.codexSandbox,
      ['workspace-write', 'danger-full-access'],
      fallback.codexSandbox,
    ),
    routing: normalizeOrchestratorRouting(source.routing),
  }
}
