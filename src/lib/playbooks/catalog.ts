import { ROUTING_PRESET_IDS, ROUTING_PRESETS } from '../routingPresets'
import type { AgentType } from '../types'

export type WindowLabel =
  | 'fiveHours'
  | 'week'
  | 'opusWeek'
  | 'gemini'
  | 'claude'
  | 'gpt'
  | 'month'
  | 'credits'
  | 'premium'
  | 'day'

export type CycleLabel = 'week' | 'creditCycle' | 'premiumCycle'

export type QuotaWindow = {
  key: string
  token: string
  label: WindowLabel
  main?: boolean
  long?: boolean
  cycle?: CycleLabel
  short?: string
}

export type ProviderDef = {
  label: string
  agent: AgentType
  cli: string
  adapter: 'built-in' | 'custom'
  readOnly: boolean
  effort: boolean
  reader: boolean
  dialect?: 'anthropic' | 'openai'
  models: string[]
  windows: QuotaWindow[]
}

const FIVE_HOURS: QuotaWindow = { key: 'short', token: '5h', label: 'fiveHours', main: true }
const WEEK: QuotaWindow = {
  key: 'week',
  token: 'week',
  label: 'week',
  main: true,
  long: true,
  cycle: 'week',
}
const CREDITS: QuotaWindow = {
  key: 'month',
  token: 'credits',
  label: 'credits',
  main: true,
  long: true,
  cycle: 'creditCycle',
}

export const BUILT_IN_PROVIDERS: Record<string, ProviderDef> = {
  claude: {
    label: 'Claude',
    agent: 'claude',
    cli: 'claude',
    adapter: 'built-in',
    readOnly: true,
    effort: true,
    reader: true,
    dialect: 'anthropic',
    models: ['haiku', 'sonnet', 'opus'],
    windows: [FIVE_HOURS, WEEK, { key: 'opus', token: 'opus', label: 'opusWeek', short: 'Opus' }],
  },
  codex: {
    label: 'Codex',
    agent: 'codex',
    cli: 'codex',
    adapter: 'built-in',
    readOnly: true,
    effort: true,
    reader: true,
    dialect: 'openai',
    models: [],
    windows: [FIVE_HOURS, WEEK],
  },
  agy: {
    label: 'Antigravity',
    agent: 'antigravity',
    cli: 'agy',
    adapter: 'built-in',
    readOnly: true,
    effort: true,
    reader: true,
    models: [],
    windows: [
      { key: 'gemini', token: 'gemini', label: 'gemini', main: true },
      { key: 'claude', token: 'claude', label: 'claude', main: true },
      { key: 'gpt', token: 'gpt', label: 'gpt' },
    ],
  },
  kimi: {
    label: 'Kimi',
    agent: 'kimi',
    cli: 'kimi',
    adapter: 'built-in',
    readOnly: true,
    effort: false,
    reader: true,
    models: [],
    windows: [FIVE_HOURS, WEEK, { key: 'month', token: 'month', label: 'month' }],
  },
  kiro: {
    label: 'Kiro',
    agent: 'kiro',
    cli: 'kiro-cli',
    adapter: 'custom',
    readOnly: false,
    effort: true,
    reader: false,
    models: [],
    windows: [CREDITS],
  },
  copilot: {
    label: 'Copilot',
    agent: 'copilot',
    cli: 'copilot',
    adapter: 'custom',
    readOnly: false,
    effort: false,
    reader: false,
    models: [],
    windows: [{ ...CREDITS, token: 'premium', label: 'premium', cycle: 'premiumCycle' }],
  },
  gemini: {
    label: 'Gemini CLI',
    agent: 'gemini',
    cli: 'gemini',
    adapter: 'custom',
    readOnly: false,
    effort: false,
    reader: false,
    models: [],
    windows: [{ key: 'day', token: 'day', label: 'day', main: true }],
  },
}

export type RouteDef = { label: string; dialects: Array<'anthropic' | 'openai'> }

export const ROUTES: Record<string, RouteDef> = {
  router9: { label: '9router', dialects: ['anthropic', 'openai'] },
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const TIER_NAMES = ['cheap', 'standard', 'strong'] as const
export const RUNNERS = ['economy', 'balanced', 'quality', 'research', 'parallel', 'rescue']
export const KINDS = ['research', 'code', 'review', 'command', 'scrap', 'docs']
export const EFFORT_CLASSES = ['light', 'standard', 'deep']
export const GATE_WINDOWS = ['short', 'week', 'opus'] as const
export const OUTCOMES = new Set([
  'checks-failed',
  'checks-failed-twice',
  'report-weak',
  'conflict',
  'stuck',
  'no-pass',
  'findings-left',
])

export type TaskId = 'all' | 'narrow' | 'research' | 'light' | 'code' | 'deep' | 'review'
export type TaskDef = { kind?: string; effort?: string; narrow?: boolean }

export const TASKS: Record<TaskId, TaskDef> = {
  all: {},
  narrow: { kind: 'code', effort: 'light', narrow: true },
  research: { kind: 'research', effort: 'standard' },
  light: { kind: 'code', effort: 'light' },
  code: { kind: 'code', effort: 'standard' },
  deep: { kind: 'code', effort: 'deep' },
  review: { kind: 'review', effort: 'standard' },
}

export const CHECKS = ['pass', 'fail', 'twice'] as const
export type ChecksId = (typeof CHECKS)[number]
export const BUDGETS = ['ok', 'low'] as const
export const SPENT_STEPS = [0, 1, 5, 10, 20, 50]
export type BudgetId = (typeof BUDGETS)[number]
export const ON_BOTH_CRITICAL = ['ask', 'run-cheapest', 'block'] as const

export type ProviderUsage = Record<string, number | null>
export type Usage = Record<string, ProviderUsage>

export const PLENTY: Usage = {
  claude: { short: 22, week: 38, opus: 12, reset: 96, expires: null },
  codex: { short: 14, week: 26, reset: 120, expires: null },
  agy: { gemini: 18, claude: 30, gpt: 6, reset: null, expires: null },
  kimi: { short: 10, week: 21, month: 15, reset: 110, expires: null },
  kiro: { month: 34, reset: 400, expires: null },
  copilot: { month: 12, reset: 300, expires: null },
  gemini: { day: 8, reset: null, expires: null },
}

export type UsagePresetId =
  | 'now'
  | 'plenty'
  | 'claude-5h'
  | 'claude-week'
  | 'codex-out'
  | 'all-out'
  | 'codex-ending'
  | 'claude-reset'
  | 'kiro-reset'

export const SIMULATED_USAGE: Record<Exclude<UsagePresetId, 'now'>, Usage | 'all'> = {
  plenty: {},
  'claude-5h': { claude: { short: 94, week: 46, opus: 30 } },
  'claude-week': { claude: { short: 35, week: 88, opus: 72, reset: 48 } },
  'codex-out': { codex: { short: 91, week: 64 } },
  'all-out': 'all',
  'codex-ending': { codex: { short: 10, week: 30, reset: 144, expires: 2 } },
  'claude-reset': { claude: { short: 18, week: 41, opus: 20, reset: 12 } },
  'kiro-reset': { kiro: { month: 38, reset: 20 } },
}

export const RESET_HOURS = [6, 12, 20, 24, 48, 72, 96, 120, 144, 168, 300, 400, 720]
export const PLAN_DAYS = [1, 2, 3, 5, 7, 14, 30]

export type RoutingRoleDef = {
  name: string
  agent: string
  model: string | null
  effort: string | null
  readOnly: boolean
  fallback: string | null
}

export type QuotaGateDef = { agent: string; window: string; below: number }

export type RoutingRuleDef = {
  kinds: string[]
  efforts: string[]
  gates: QuotaGateDef[]
  role: string
}

export type RoutingPresetKey = (typeof ROUTING_PRESET_IDS)[number]

export function routingPreset(key: RoutingPresetKey): {
  roles: RoutingRoleDef[]
  rules: RoutingRuleDef[]
} {
  const preset = ROUTING_PRESETS[key]
  return {
    roles: preset.roles.map((role) => ({
      name: role.name,
      agent: role.agent,
      model: role.model,
      effort: role.effort,
      readOnly: role.readOnly,
      fallback: role.fallback ?? null,
    })),
    rules: preset.rules.map((rule) => ({
      kinds: [...rule.kinds],
      efforts: [...rule.efforts],
      gates: rule.gates.map((gate) => ({ ...gate })),
      role: rule.role,
    })),
  }
}

export const ROUTING_KEYS: readonly RoutingPresetKey[] = ROUTING_PRESET_IDS
