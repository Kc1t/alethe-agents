import {
  DEFAULT_PREFERENCES,
  DEFAULT_ROUTING_SETTINGS,
  type DelegateKind,
  type EffortClass,
  type OrchestrationRole,
  type OrchestrationSettings,
  type QuotaGate,
  type RoutingRule,
  type RoutingSettings,
} from './types'

const DEFAULTS = DEFAULT_PREFERENCES.orchestration

export const MAX_CONCURRENT_LIMITS = { min: 1, max: 16 } as const

/** What `claude --effort` takes (Claude Code 2.1.285). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The efforts every model Codex 0.159 lists accepts, offered when Codex could not be asked for
 * its models. Without them a role could only run on the model's default effort.
 */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** A week. Past what any worker budget needs, and far below what the orchestrator can hold. */
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60

/**
 * A role, model or effort name the orchestrator accepts: not empty, no whitespace, and not starting
 * with `-`, because a Claude model ends up on a command line.
 */
export function isOrchestrationName(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[\s\p{Cc}]/u.test(value)
}

const optionalName = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && isOrchestrationName(value))

const wholeSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_SECONDS

/** A row's orchestrator: absent or null serves any planner. */
const ORCHESTRATORS: readonly unknown[] = [undefined, null, 'claude', 'codex']

/** Whether the orchestrator would run this role as it is written. */
export function isValidRole(role: unknown): role is OrchestrationRole {
  if (!role || typeof role !== 'object') return false
  const { name, agent, model, effort, readOnly, timeoutSeconds, orchestrator } = role as Record<
    string,
    unknown
  >
  if (typeof name !== 'string' || !isOrchestrationName(name)) return false
  if (agent !== 'codex' && agent !== 'claude') return false
  if (!optionalName(model) || !optionalName(effort) || typeof readOnly !== 'boolean') return false
  if (timeoutSeconds !== null && !wholeSeconds(timeoutSeconds)) return false
  if (!ORCHESTRATORS.includes(orchestrator)) return false
  // The headless Claude launch bypasses permissions and has no read-only mode.
  return agent === 'codex' || !readOnly
}

/**
 * Settings read from disk. A role the orchestrator would refuse is dropped rather than repaired:
 * making a read-only Claude role writable, say, would change what it means.
 */
export function normalizeOrchestrationSettings(raw: unknown): OrchestrationSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // One row per name and orchestrator (#276). Names hold no whitespace, so the key is unambiguous.
  const seen = new Set<string>()
  const roles = (Array.isArray(source.roles) ? source.roles : []).filter(
    (role): role is OrchestrationRole => {
      if (!isValidRole(role)) return false
      const key = `${role.orchestrator ?? ''} ${role.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  )
  const maxConcurrent =
    typeof source.maxConcurrent === 'number' && Number.isFinite(source.maxConcurrent)
      ? Math.min(
          MAX_CONCURRENT_LIMITS.max,
          Math.max(MAX_CONCURRENT_LIMITS.min, Math.round(source.maxConcurrent)),
        )
      : DEFAULTS.maxConcurrent
  const defaultTimeoutSeconds = wholeSeconds(source.defaultTimeoutSeconds)
    ? source.defaultTimeoutSeconds
    : DEFAULTS.defaultTimeoutSeconds
  return {
    roles: roles.map(({ fallback, orchestrator, ...rest }) => {
      const role = orchestrator ? { ...rest, orchestrator } : rest
      return fallback && canFallBackToName(role, fallback, roles) ? { ...role, fallback } : role
    }),
    maxConcurrent,
    defaultTimeoutSeconds,
    workerDisabledPlugins: pluginIds(
      Array.isArray(source.workerDisabledPlugins) ? source.workerDisabledPlugins : [],
    ),
    routing: normalizeRoutingSettings(source.routing),
  }
}

const DELEGATE_KINDS: readonly unknown[] = ['research', 'code', 'review', 'command', 'scrap', 'docs']
const EFFORT_CLASSES: readonly unknown[] = ['light', 'standard', 'deep']
const GATE_AGENTS: readonly unknown[] = ['claude', 'codex']
const GATE_WINDOWS: readonly unknown[] = ['short', 'week', 'opus']
const ROUTING_PRESET_IDS: readonly unknown[] = ['economy', 'balanced', 'performance', 'custom']
const ON_BOTH_CRITICAL: readonly unknown[] = ['ask', 'run-cheapest', 'block']

/** A gate keeps only what the orchestrator can evaluate: known window, whole percent 1–99. */
export function isValidQuotaGate(gate: unknown): gate is QuotaGate {
  if (!gate || typeof gate !== 'object') return false
  const { agent, window, below } = gate as Record<string, unknown>
  return (
    GATE_AGENTS.includes(agent) &&
    GATE_WINDOWS.includes(window) &&
    typeof below === 'number' &&
    Number.isInteger(below) &&
    below >= 1 &&
    below <= 99
  )
}

/**
 * Whether the orchestrator would evaluate this rule. A rule naming a role that does not exist is
 * kept — the router skips it at resolve time and the Preferences editor flags it, so renaming a
 * role never silently deletes the rules pointing at it.
 */
export function isValidRoutingRule(rule: unknown): rule is RoutingRule {
  if (!rule || typeof rule !== 'object') return false
  const { id, enabled, kinds, efforts, gates, role } = rule as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return false
  if (typeof enabled !== 'boolean') return false
  if (typeof role !== 'string' || !isOrchestrationName(role)) return false
  const list = (value: unknown, allowed: readonly unknown[]) =>
    Array.isArray(value) && value.every((entry) => allowed.includes(entry))
  if (!list(kinds, DELEGATE_KINDS) || !list(efforts, EFFORT_CLASSES)) return false
  return Array.isArray(gates) && gates.every(isValidQuotaGate)
}

/** Routing settings read from disk; invalid rules and gates are dropped, not repaired. */
export function normalizeRoutingSettings(raw: unknown): RoutingSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const seen = new Set<string>()
  const rules = (Array.isArray(source.rules) ? source.rules : []).filter(
    (rule): rule is RoutingRule => {
      if (!isValidRoutingRule(rule) || seen.has(rule.id)) return false
      seen.add(rule.id)
      return true
    },
  )
  const threshold = source.criticalThreshold
  return {
    preset: ROUTING_PRESET_IDS.includes(source.preset)
      ? (source.preset as RoutingSettings['preset'])
      : DEFAULT_ROUTING_SETTINGS.preset,
    rules,
    criticalThreshold:
      typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= 10 && threshold <= 99
        ? threshold
        : DEFAULT_ROUTING_SETTINGS.criticalThreshold,
    allowOpusOnDeep:
      typeof source.allowOpusOnDeep === 'boolean'
        ? source.allowOpusOnDeep
        : DEFAULT_ROUTING_SETTINGS.allowOpusOnDeep,
    onBothCritical: ON_BOTH_CRITICAL.includes(source.onBothCritical)
      ? (source.onBothCritical as RoutingSettings['onBothCritical'])
      : DEFAULT_ROUTING_SETTINGS.onBothCritical,
  }
}

/** Lists the UI needs when editing rules, typed as the real unions. */
export const ROUTING_KINDS = DELEGATE_KINDS as readonly DelegateKind[]
export const ROUTING_EFFORT_CLASSES = EFFORT_CLASSES as readonly EffortClass[]

/**
 * Whether `role` may run as `fallback` while its provider is running out (#268): another role,
 * and never a writable one for a read-only role. The orchestrator checks the same.
 */
export function canFallBackTo(
  role: Pick<OrchestrationRole, 'name' | 'readOnly'>,
  fallback: Pick<OrchestrationRole, 'name' | 'readOnly'> | undefined,
): boolean {
  if (!fallback || fallback.name === role.name) return false
  return !role.readOnly || fallback.readOnly
}

/**
 * Whether `role` may keep `name` as its fallback: a row of that name it reaches may run in its
 * place. A row for one orchestrator reaches that orchestrator's row of the name, else the row for
 * any; a row for any serves every planner, so it reaches every row of the name (#276).
 */
export function canFallBackToName(
  role: Pick<OrchestrationRole, 'name' | 'readOnly' | 'orchestrator'>,
  name: string,
  roles: readonly OrchestrationRole[],
): boolean {
  const named = roles.filter((other) => other.name === name)
  const reached = role.orchestrator
    ? [
        named.find((other) => other.orchestrator === role.orchestrator) ??
          named.find((other) => !other.orchestrator),
      ]
    : named
  return reached.some((other) => canFallBackTo(role, other))
}

/** Codex plugin ids, each once; anything Codex could not take as an id is dropped. */
export function pluginIds(values: readonly unknown[]): string[] {
  const ids = values.filter(
    (value): value is string => typeof value === 'string' && isOrchestrationName(value),
  )
  return [...new Set(ids)]
}
