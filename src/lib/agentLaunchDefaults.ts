import {
  AGENT_EFFORT_LEVELS,
  type AgentDefaultsPreferences,
  type AgentEffortLevel,
  type AgentLaunchDefaults,
  type AgentType,
  type OrchestrationRole,
  ORCHESTRATOR_DEFAULT_MAX_WORKERS,
  ORCHESTRATOR_MAX_WORKERS,
  ORCHESTRATOR_MIN_WORKERS,
} from './types'

type ProviderLaunchFlags = {
  model: (model: string) => string[]
  effort?: {
    /** Every level the CLI takes for some model; anything else never reaches argv. */
    levels: readonly AgentEffortLevel[]
    /** What to offer when the chosen model's own list is not known: levels every model takes. */
    common: readonly AgentEffortLevel[]
    args: (level: AgentEffortLevel) => string[]
  }
}

/**
 * How each CLI is told which model and effort to use. A provider missing here has no documented
 * way to take one at launch, so its panes are left on whatever the CLI is configured with.
 *
 * Codex gets the long `--config`: other providers' session stripping treats a bare `-c` as
 * "continue", and one spelling for every call site is easier to recognise when deduplicating.
 */
const PROVIDER_LAUNCH_FLAGS: Partial<Record<AgentType, ProviderLaunchFlags>> = {
  claude: {
    model: (model) => ['--model', model],
    effort: {
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      common: ['low', 'medium', 'high', 'xhigh', 'max'],
      args: (level) => ['--effort', level],
    },
  },
  codex: {
    model: (model) => ['--model', model],
    effort: {
      // Codex takes whatever the chosen model advertises in `model/list`, and newer models go past
      // `high`. Low, medium and high are the ones every reasoning model it ships with supports.
      levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      common: ['low', 'medium', 'high'],
      args: (level) => ['--config', `model_reasoning_effort=${level}`],
    },
  },
  opencode: {
    model: (model) => ['--model', model],
  },
}

const CODEX_EFFORT_KEY = 'model_reasoning_effort='

/**
 * A model name becomes an argv token, so it is held to the characters real model ids use
 * (`provider/model`, `opus[1m]`, `gpt-5:latest`) and nothing a shell could reinterpret.
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/

export function isValidModelName(value: string): boolean {
  return MODEL_NAME_PATTERN.test(value)
}

/** Providers whose default model can be set from preferences. */
export function agentsWithLaunchDefaults(): AgentType[] {
  return Object.keys(PROVIDER_LAUNCH_FLAGS)
}

export function supportsModelDefault(agent: AgentType): boolean {
  return Boolean(PROVIDER_LAUNCH_FLAGS[agent])
}

/** Every level the provider accepts; empty when it has no effort setting at all. */
export function effortLevelsFor(agent: AgentType): readonly AgentEffortLevel[] {
  return PROVIDER_LAUNCH_FLAGS[agent]?.effort?.levels ?? []
}

/** What a CLI reported about one of its models. */
export type ModelEffortInfo = { id: string; efforts?: readonly string[]; isDefault?: boolean }

/**
 * The levels to offer for `model` (none chosen means the CLI's default model): the ones that model
 * advertises when its CLI said, otherwise the ones every model of the provider takes. `current`
 * stays listed even when the model does not advertise it, so a saved value is never hidden.
 */
export function effortLevelsForModel(
  agent: AgentType,
  model: string | undefined,
  models: readonly ModelEffortInfo[],
  current?: AgentEffortLevel,
): readonly AgentEffortLevel[] {
  const effort = PROVIDER_LAUNCH_FLAGS[agent]?.effort
  if (!effort) return []
  const entry = model
    ? models.find((candidate) => candidate.id === model)
    : models.find((candidate) => candidate.isDefault)
  const advertised = entry?.efforts
    ? effort.levels.filter((level) => entry.efforts?.includes(level))
    : effort.common
  if (!current || advertised.includes(current) || !effort.levels.includes(current)) {
    return advertised
  }
  return AGENT_EFFORT_LEVELS.filter((level) => advertised.includes(level) || level === current)
}

/** Drops anything the provider cannot be launched with, so a stale value never reaches argv. */
export function normalizeLaunchDefaults(agent: AgentType, raw: unknown): AgentLaunchDefaults {
  if (!raw || typeof raw !== 'object' || !supportsModelDefault(agent)) return {}
  const candidate = raw as { model?: unknown; effort?: unknown }
  const normalized: AgentLaunchDefaults = {}
  const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  if (model && isValidModelName(model)) normalized.model = model
  const effort = candidate.effort as AgentEffortLevel
  if (effortLevelsFor(agent).includes(effort)) normalized.effort = effort
  return normalized
}

function normalizeDefaultsMap(raw: unknown): Partial<Record<AgentType, AgentLaunchDefaults>> {
  if (!raw || typeof raw !== 'object') return {}
  const normalized: Partial<Record<AgentType, AgentLaunchDefaults>> = {}
  for (const [agent, value] of Object.entries(raw)) {
    const entry = normalizeLaunchDefaults(agent, value)
    if (entry.model || entry.effort) normalized[agent] = entry
  }
  return normalized
}

/** Persisted preferences can be hand-edited or synced from another version; keep only what holds. */
export function normalizeAgentDefaultsPreferences(raw: unknown): AgentDefaultsPreferences {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof AgentDefaultsPreferences, unknown>
  >
  return {
    providers: normalizeDefaultsMap(source.providers),
    planner: normalizeDefaultsMap(source.planner),
    worker: normalizeDefaultsMap(source.worker),
  }
}

export function clampOrchestratorMaxWorkers(value: unknown): number {
  const limit = Math.round(Number(value))
  if (!Number.isFinite(limit)) return ORCHESTRATOR_DEFAULT_MAX_WORKERS
  return Math.min(ORCHESTRATOR_MAX_WORKERS, Math.max(ORCHESTRATOR_MIN_WORKERS, limit))
}

/** What a pane of this agent launches with: the role's choice, falling back to the provider's. */
export function resolveLaunchDefaults(
  preferences: AgentDefaultsPreferences | undefined,
  agent: AgentType,
  role?: OrchestrationRole,
): AgentLaunchDefaults {
  if (!preferences) return {}
  const base = normalizeLaunchDefaults(agent, preferences.providers?.[agent])
  if (!role) return base
  return { ...base, ...normalizeLaunchDefaults(agent, preferences[role]?.[agent]) }
}

function alreadyChoosesModel(args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      arg === '--model' ||
      arg === '-m' ||
      arg.startsWith('--model=') ||
      // Codex also takes the model as a config override.
      ((args[index - 1] === '-c' || args[index - 1] === '--config') && arg.startsWith('model=')),
  )
}

function alreadyChoosesEffort(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg === '--effort' || arg.startsWith('--effort=') || arg.includes(CODEX_EFFORT_KEY),
  )
}

/**
 * Appends the default model and effort flags. Anything the tab already carries wins: a merge or
 * review agent pins its own `--model`, and a person may have typed one into the extra arguments.
 * Flags go last so a leading subcommand such as `resume <id>` keeps its place.
 */
export function applyLaunchDefaults(
  agent: AgentType,
  args: readonly string[],
  defaults: AgentLaunchDefaults | undefined,
): string[] {
  const flags = PROVIDER_LAUNCH_FLAGS[agent]
  const result = [...args]
  if (!flags || !defaults) return result
  const { model, effort } = normalizeLaunchDefaults(agent, defaults)
  if (model && !alreadyChoosesModel(args)) result.push(...flags.model(model))
  if (effort && flags.effort && !alreadyChoosesEffort(args)) {
    result.push(...flags.effort.args(effort))
  }
  return result
}
