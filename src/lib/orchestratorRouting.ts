import type { AgentFitness } from './agentFitness'
import { agentLabel } from './agentProviders'
import type { MessageKey, TFunction } from './i18n'
import type { OrchestratorRouting } from './tauri'
import type { AgentType, OrchestratorRoute } from './types'

const TIER_KEYS: Record<NonNullable<OrchestratorRouting['tier']>, MessageKey> = {
  light: 'orchestrator.tier.light',
  standard: 'orchestrator.tier.standard',
  deep: 'orchestrator.tier.deep',
}

/**
 * Why a worker ran where it ran, in one short line. A `routed` note names the complexity tier and,
 * when the task was moved off its primary route, what that route's usage was at the time.
 */
export function routingNoteText(routing: OrchestratorRouting, t: TFunction): string {
  if (routing.verdict !== 'routed') {
    return t(
      routing.verdict === 'ignored' ? 'orchestrator.routingIgnored' : 'orchestrator.routingChosen',
      { agent: routing.agent, window: routing.window ?? '', used: String(routing.used) },
    )
  }
  const tier = t(TIER_KEYS[routing.tier ?? 'standard'])
  const avoided = routing.avoided
  if (avoided) {
    const agent = agentLabel(avoided.agent as AgentType)
    return avoided.rateLimited
      ? t('orchestrator.routingRoutedLimited', { tier, agent })
      : t('orchestrator.routingRoutedFallback', { tier, agent, used: String(avoided.used) })
  }
  return t(
    routing.route === 'fallback'
      ? 'orchestrator.routingRoutedNoPrimary'
      : 'orchestrator.routingRouted',
    { tier },
  )
}

/**
 * How used the provider behind a route is, as a percentage: its fullest window, where the Opus
 * window only counts for an Opus route. Infinity when the provider is refusing requests, null when
 * there is no reading yet. Mirrors `route_pressure` in the orchestrator core.
 */
export function routePressure(
  fitness: AgentFitness | undefined,
  route: OrchestratorRoute,
): number | null {
  if (!fitness) return null
  if (fitness.rateLimited) return Infinity
  const opus = route.agent === 'claude' && (route.model ?? '').toLowerCase().includes('opus')
  const windows = Object.entries(fitness.windows).filter(([name]) => name !== 'opus' || opus)
  if (windows.length === 0) return fitness.used
  return Math.max(0, ...windows.map(([, window]) => window.used))
}

export type RouteCandidate = {
  /** Whether the route's CLI is installed; one that is not can never take a task. */
  installed: boolean
  /** Its provider's usage, or null when unknown, which the core reads as no usage at all. */
  pressure: number | null
}

/**
 * The route of a tier a task would start on right now, or null when none can take it. Mirrors
 * `route_task` in the orchestrator core: the first route below the watch band, else the first below
 * the protect band, else the one with the most room left.
 */
export function pickRoute(
  candidates: readonly RouteCandidate[],
  bands: { watchPercent: number; protectPercent: number },
): number | null {
  const usable = candidates
    .map((candidate, index) => ({ index, used: candidate.pressure ?? 0, ok: candidate.installed }))
    .filter((candidate) => candidate.ok)
  if (usable.length === 0) return null
  const pick =
    usable.find((candidate) => candidate.used < bands.watchPercent) ??
    usable.find((candidate) => candidate.used < bands.protectPercent) ??
    usable.reduce((best, candidate) => (candidate.used < best.used ? candidate : best))
  return pick.index
}

const RULE_KEYS: Record<string, MessageKey> = {
  approvalsOn: 'orchestrator.rule.approvalsOn',
  approvalsOff: 'orchestrator.rule.approvalsOff',
  isolation: 'orchestrator.rule.isolation',
  webSearchOff: 'orchestrator.rule.webSearchOff',
}

/**
 * The person's rules that changed what the planner asked for, in words. A rule this version does
 * not know is left out rather than shown as a raw id.
 */
export function ruleOverrideLabels(
  overrides: readonly string[] | undefined,
  t: TFunction,
): string[] {
  return (overrides ?? []).flatMap((rule) => (RULE_KEYS[rule] ? [t(RULE_KEYS[rule])] : []))
}
