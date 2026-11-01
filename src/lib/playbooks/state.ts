import {
  type BudgetId,
  BUILT_IN_PROVIDERS,
  type ChecksId,
  EFFORT_CLASSES,
  OUTCOMES,
  PLENTY,
  type ProviderDef,
  type QuotaWindow,
  ROUTING_KEYS,
  routingPreset,
  type RoutingPresetKey,
  type RoutingRoleDef,
  type RoutingRuleDef,
  SIMULATED_USAGE,
  type TaskDef,
  type TaskId,
  TASKS,
  TIER_NAMES,
  type Usage,
  type UsagePresetId,
} from './catalog'
import type { DocProblem, FlowDoc } from './flowDoc'
import { modelPrice } from './prices'
import { emitPlaybooksYaml, parsePlaybooksYaml } from './yaml'

export type Cond = string | string[]
export type PhaseUse = { tier?: string; provider?: string; model?: string; effort?: string }
export type PhaseRule = { if?: Cond; use?: PhaseUse }

export type Phase = {
  id: string
  role?: string
  who?: string
  tier?: string
  provider?: string
  model?: string
  effort?: string
  readOnly?: boolean
  workers?: number
  isolate?: boolean
  runner?: string
  with?: string
  after?: string
  if?: Cond
  then?: string
  does?: string
  returns?: string
  limit?: string | number
  gate?: string
  rules?: PhaseRule[]
  [key: string]: unknown
}

export type Playbook = {
  name: string
  goal?: string
  pickWhen?: string
  saves?: string
  avoidWhen?: string
  source?: string
  next?: string
  phases: Phase[]
  [key: string]: unknown
}

export type TierUse = { model?: string; effort?: string }
export type Tiers = Record<string, Record<string, TierUse>>

export type QuotaRule = {
  criticalThreshold: number
  stopAt: number
  whenLow: string
  onBothCritical: string
  whenSpare: string
  spareWithinHours: number
  spareMinLeft: number
  planEnds: Record<string, string>
  [key: string]: unknown
}

export type BudgetRule = { warnAt: number; whenLow: string; [key: string]: unknown }

export type Profile = {
  name?: string
  summary?: string
  order?: string[]
  quota?: Partial<QuotaRule>
  tiers?: Tiers
  [key: string]: unknown
}

export type RouteState = {
  port?: number
  running?: boolean
  carries?: string[]
  [key: string]: unknown
}
export type Point = { x: number; y: number }

export type PlaybookWorkflow = {
  id: string
  kind: 'playbook'
  key: string
  pb: Playbook
  positions: Record<string, Point>
  edited: boolean
  doc?: FlowDoc
  problems?: DocProblem[]
  alias?: Record<string, string>
  skips?: Record<string, string>
}

export type RoutingWorkflow = {
  id: string
  kind: 'routing'
  key: RoutingPresetKey
  roles: RoutingRoleDef[]
  rules: RoutingRuleDef[]
  positions: Record<string, Point>
  edited: boolean
}

export type Workflow = PlaybookWorkflow | RoutingWorkflow

type Patterns = { state: RegExp; above: RegExp; problem: RegExp }

export type PlaybooksState = {
  data: Record<string, unknown>
  catalog: Record<string, ProviderDef>
  patterns: Patterns
  workflows: Record<string, Workflow>
  liveUsage: Usage | null
  wf: string
  task: TaskId
  usage: Usage
  checks: ChecksId
  budget: BudgetId
  spent: number
  providers: string[]
  routes: Record<string, RouteState>
  profiles: Record<string, Profile>
  profile: string
  quota: QuotaRule
  budgetRule: BudgetRule
  tiers: Tiers
  globalEdited: boolean
  routingWf: string
}

export type Context = {
  all: boolean
  task: TaskDef
  low: string[]
  spare: string[]
  failed: boolean
  failedTwice: boolean
  budgetLow: boolean
  spent: number
}

export type CostSubject = { provider: string; model: string | null }

export const COST_TOKEN = /^(price|spent)-above:(\d+(?:\.\d{1,2})?)$/

export type ResolvedUse = {
  provider: string
  tier: string | null
  model: string | null
  effort: string | null
  via: string | null
}

export type Chosen = { i: number; cond: string[]; use: PhaseUse }

export type Resolution = {
  lead: boolean
  base: ResolvedUse
  final: ResolvedUse
  planned: ResolvedUse
  chosen: Chosen | null
  switched: boolean
  stuck: boolean
  spent: string | null
}

export type Alt = {
  key: string
  cond: string[]
  use: ResolvedUse
  ruleIndex?: number
  implicit?: boolean
  as?: string
  spare?: boolean
}

export type Spare =
  | {
      provider: string
      left: number
      hours: number
      cycle: QuotaWindow
      reason: 'plan'
      days: number
      reset: number | null
    }
  | { provider: string; left: number; hours: number; cycle: QuotaWindow; reason: 'reset' }

type Base = { provider: string; tier: string | null; model: string | null; effort: string | null }

export const isMap = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const condList = (cond: Cond | undefined | null): string[] =>
  cond === undefined || cond === null ? [] : Array.isArray(cond) ? cond : [cond]

function validate(data: unknown): Record<string, unknown> {
  if (!isMap(data) || !isMap(data.playbooks)) throw new Error('the file has no playbooks mapping')
  for (const [key, pb] of Object.entries(data.playbooks)) {
    if (
      !isMap(pb) ||
      !Array.isArray(pb.phases) ||
      pb.phases.some((phase) => !isMap(phase) || typeof phase.id !== 'string')
    )
      throw new Error(`playbook ${key} needs a phases list with an id on every phase`)
  }
  return data
}

function buildCatalog(data: Record<string, unknown>): Record<string, ProviderDef> {
  const catalog: Record<string, ProviderDef> = { ...BUILT_IN_PROVIDERS }
  const adapters = isMap(data.adapters) ? data.adapters : {}
  const listed = Array.isArray(data.providers) ? data.providers : []
  ;[...listed, ...Object.keys(adapters)].forEach((id) => {
    if (typeof id !== 'string' || catalog[id]) return
    const adapter = adapters[id]
    catalog[id] = {
      label: id,
      agent: id,
      cli: isMap(adapter) && typeof adapter.command === 'string' ? adapter.command : id,
      adapter: 'custom',
      readOnly: false,
      effort: false,
      reader: false,
      models: [],
      windows: [
        {
          key: 'month',
          token: 'credits',
          label: 'credits',
          main: true,
          long: true,
          cycle: 'creditCycle',
        },
      ],
    }
  })
  return catalog
}

function buildPatterns(catalog: Record<string, ProviderDef>): Patterns {
  const ids = Object.keys(catalog)
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return {
    state: new RegExp(`^(${ids})-(low|spare)$`),
    above: new RegExp(`^(${ids})(?:-([a-z0-9]+))?-above:(\\d+)$`),
    problem: new RegExp(
      `^(budget-low|spent-above:[\\d.]+|both-low|all-low|(${ids})-(low|spare)|(${ids})(-[a-z0-9]+)?-above:\\d+)$`,
    ),
  }
}

function loadedRouting(data: Record<string, unknown>): {
  key: RoutingPresetKey
  roles: RoutingRoleDef[]
  rules: RoutingRuleDef[]
} | null {
  const routing = data.routing
  if (!isMap(routing) || !Array.isArray(routing.roles) || !Array.isArray(routing.rules)) return null
  const key = ROUTING_KEYS.find((id) => id === routing.basedOn)
  if (!key) return null
  const text = (value: unknown) => (typeof value === 'string' && value !== 'default' ? value : null)
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const roles = routing.roles.filter(isMap).map((role) => ({
    name: String(role.name ?? ''),
    agent: String(role.agent ?? 'claude'),
    model: text(role.model),
    effort: text(role.effort),
    readOnly: role.readOnly === true,
    fallback: text(role.fallback),
  }))
  const rules = routing.rules.filter(isMap).map((rule) => ({
    kinds: strings(isMap(rule.when) ? rule.when.kinds : undefined),
    efforts: strings(isMap(rule.when) ? rule.when.efforts : undefined),
    gates: (Array.isArray(rule.onlyIf) ? rule.onlyIf : []).filter(isMap).map((gate) => ({
      agent: String(gate.agent ?? 'claude'),
      window: String(gate.window ?? 'opus'),
      below: Number(gate.below ?? 50),
    })),
    role: String(rule.role ?? ''),
  }))
  return { key, roles, rules }
}

function buildWorkflows(data: Record<string, unknown>): Record<string, Workflow> {
  const pickOrder = Array.isArray(data.pickOrder) ? data.pickOrder : []
  const pickRank = (key: string) => {
    if (key === 'complete') return -1
    const index = pickOrder.findIndex((item) => isMap(item) && item.playbook === key)
    return index === -1 ? 99 : index
  }
  const workflows: Record<string, Workflow> = {}
  Object.entries(data.playbooks as Record<string, Playbook>)
    .sort((a, b) => pickRank(a[0]) - pickRank(b[0]))
    .forEach(([key, pb]) => {
      workflows[`playbook:${key}`] = {
        id: `playbook:${key}`,
        kind: 'playbook',
        key,
        pb: clone(pb),
        positions: {},
        edited: false,
      }
    })
  const loaded = loadedRouting(data)
  ROUTING_KEYS.forEach((key) => {
    const preset = loaded?.key === key ? loaded : routingPreset(key)
    workflows[`routing:${key}`] = {
      id: `routing:${key}`,
      kind: 'routing',
      key,
      roles: preset.roles,
      rules: preset.rules,
      positions: {},
      edited: false,
    }
  })
  return workflows
}

export function createPlaybooksState(text: string, today = new Date()): PlaybooksState {
  const data = validate(parsePlaybooksYaml(text.replace(/^\r?\n/, '')))
  const catalog = buildCatalog(data)
  const workflows = buildWorkflows(data)
  const profiles = clone(
    isMap(data.profiles)
      ? (data.profiles as Record<string, Profile>)
      : { base: { name: 'Base', summary: 'The tiers as written.' } },
  )
  const routingBase = loadedRouting(data)?.key ?? 'balanced'
  const state: PlaybooksState = {
    data,
    catalog,
    patterns: buildPatterns(catalog),
    workflows,
    liveUsage: null,
    wf: Object.keys(workflows)[0],
    task: 'all',
    usage: {},
    checks: 'pass',
    budget: 'ok',
    spent: 0,
    providers: [],
    routes: clone(isMap(data.routes) ? (data.routes as Record<string, RouteState>) : {}),
    profiles,
    profile:
      typeof data.profile === 'string' && profiles[data.profile]
        ? data.profile
        : Object.keys(profiles)[0],
    quota: {
      criticalThreshold: 80,
      stopAt: 95,
      whenLow: 'switch-provider',
      onBothCritical: 'ask',
      whenSpare: 'spend-strong',
      spareWithinHours: 24,
      spareMinLeft: 30,
      planEnds: {},
      ...clone(isMap(data.quota) ? data.quota : {}),
    },
    budgetRule: {
      warnAt: 80,
      whenLow: 'finish-and-report',
      ...clone(isMap(data.budget) ? data.budget : {}),
    },
    tiers: clone(isMap(data.tiers) ? (data.tiers as Tiers) : {}),
    globalEdited: false,
    routingWf: `routing:${routingBase}`,
  }
  state.providers = inventory(state)
  state.usage = presetUsage(state, 'plenty')
  applyPlanEnds(state, today)
  return state
}

function applyPlanEnds(s: PlaybooksState, today: Date) {
  Object.entries(s.quota.planEnds ?? {}).forEach(([provider, date]) => {
    if (s.usage[provider]) s.usage[provider].expires = daysUntil(String(date), today)
  })
}

export function inventory(s: PlaybooksState): string[] {
  const listed = Array.isArray(s.data.providers) ? s.data.providers : ['claude', 'codex']
  return listed.filter((id): id is string => typeof id === 'string' && Boolean(s.catalog[id]))
}

export const providerLabel = (s: PlaybooksState, id: string) => s.catalog[id]?.label ?? id

const modelIdOf = (model: unknown) =>
  isMap(model) ? (model.id as string | undefined) : (model as string | undefined)

function recordedModels(s: PlaybooksState, id: string): unknown[] {
  const models = isMap(s.data.models) ? s.data.models[id] : undefined
  return Array.isArray(models) ? models : []
}

export function modelsOf(s: PlaybooksState, id: string): string[] {
  const listed = recordedModels(s, id)
    .map(modelIdOf)
    .filter((model): model is string => typeof model === 'string')
  return [...new Set([...(s.catalog[id]?.models ?? []), ...listed])]
}

export function modelCost(s: PlaybooksState, id: string, model: string): number | null {
  const found = recordedModels(s, id).find((entry) => isMap(entry) && entry.id === model)
  return isMap(found) && typeof found.cost === 'number' ? found.cost : null
}

export const modelOwner = (s: PlaybooksState, model: string) =>
  Object.keys(s.catalog).find((id) => modelsOf(s, id).includes(model)) ?? null

export const profileNow = (s: PlaybooksState): Profile => s.profiles[s.profile] ?? {}

export const quotaNow = (s: PlaybooksState): QuotaRule => ({
  ...s.quota,
  ...(profileNow(s).quota ?? {}),
})

export function activeOrder(s: PlaybooksState): string[] {
  const order = (profileNow(s).order ?? s.providers).filter((id) => s.providers.includes(id))
  return [...order, ...s.providers.filter((id) => !order.includes(id))]
}

export function tiersNow(s: PlaybooksState): Tiers {
  const out: Tiers = {}
  TIER_NAMES.forEach((tier) => {
    out[tier] = { ...(s.tiers[tier] ?? {}), ...(profileNow(s).tiers?.[tier] ?? {}) }
  })
  return out
}

export const routedVia = (s: PlaybooksState, provider: string) =>
  Object.entries(s.routes).find(([, route]) => (route.carries ?? []).includes(provider))?.[0] ??
  null

export const windowsOf = (s: PlaybooksState, provider: string): QuotaWindow[] =>
  s.catalog[provider]?.windows ?? []

export const windowByToken = (s: PlaybooksState, provider: string, token: string) =>
  windowsOf(s, provider).find((w) => w.token === token) ?? null

export const longWindow = (s: PlaybooksState, provider: string) =>
  windowsOf(s, provider).find((w) => w.long) ?? null

export const usageOf = (s: PlaybooksState, provider: string, key: string) =>
  s.usage[provider]?.[key] ?? 0

export const resetOf = (s: PlaybooksState, provider: string) => s.usage[provider]?.reset ?? null
export const expiresOf = (s: PlaybooksState, provider: string) => s.usage[provider]?.expires ?? null

export const mainLoad = (s: PlaybooksState, provider: string) =>
  Math.max(
    0,
    ...windowsOf(s, provider)
      .filter((w) => w.main)
      .map((w) => usageOf(s, provider, w.key)),
  )

export const lowProviders = (s: PlaybooksState) =>
  s.providers.filter((p) => mainLoad(s, p) >= quotaNow(s).criticalThreshold)

export function spareOf(s: PlaybooksState, provider: string): Spare | null {
  const long = longWindow(s, provider)
  if (!long) return null
  const q = quotaNow(s)
  const left = 100 - usageOf(s, provider, long.key)
  if (lowProviders(s).includes(provider) || left < q.spareMinLeft) return null
  const reset = resetOf(s, provider)
  const ends = expiresOf(s, provider)
  if (ends !== null && (reset === null || ends * 24 < reset))
    return { provider, left, hours: ends * 24, cycle: long, reason: 'plan', days: ends, reset }
  if (reset !== null && reset <= q.spareWithinHours)
    return { provider, left, hours: reset, cycle: long, reason: 'reset' }
  return null
}

export const spareProviders = (s: PlaybooksState) =>
  s.providers
    .map((provider) => spareOf(s, provider))
    .filter((spare): spare is Spare => spare !== null)
    .sort((a, b) => a.hours - b.hours)
    .map((spare) => spare.provider)

export function daysUntil(date: string, today = new Date()): number | null {
  const start = new Date(today)
  start.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(`${date}T00:00:00`).getTime() - start.getTime()) / 86400000)
  return Number.isFinite(days) && days > 0 ? days : null
}

export function usagePresetIds(s: PlaybooksState): UsagePresetId[] {
  const simulated = (Object.keys(SIMULATED_USAGE) as Array<keyof typeof SIMULATED_USAGE>).filter(
    (key) => {
      const patch = SIMULATED_USAGE[key]
      return patch === 'all' || Object.keys(patch).every((id) => s.providers.includes(id))
    },
  )
  return [...(s.liveUsage ? (['now'] as const) : []), ...simulated]
}

export function presetUsage(s: PlaybooksState, key: UsagePresetId): Usage {
  const patch = key === 'now' ? (s.liveUsage ?? {}) : SIMULATED_USAGE[key]
  const usage: Usage = {}
  s.providers.forEach((id, n) => {
    usage[id] = { ...(PLENTY[id] ?? { reset: null, expires: null }) }
    if (patch === 'all')
      windowsOf(s, id)
        .filter((w) => w.main)
        .forEach((w, i) => {
          usage[id][w.key] = 91 + ((n + i * 2) % 7)
        })
    else Object.assign(usage[id], patch[id] ?? {})
  })
  return usage
}

export function usageKey(s: PlaybooksState): UsagePresetId | 'custom' {
  const current = JSON.stringify(s.usage)
  return (
    usagePresetIds(s).find((key) => JSON.stringify(presetUsage(s, key)) === current) ?? 'custom'
  )
}

export function applyLiveUsage(s: PlaybooksState, live: Usage, today = new Date()) {
  const untouched = usageKey(s) === 'plenty'
  s.liveUsage = Object.keys(live).length ? live : null
  if (untouched && s.liveUsage) {
    s.usage = presetUsage(s, 'now')
    applyPlanEnds(s, today)
  }
}

export function context(s: PlaybooksState): Context {
  return {
    all: s.task === 'all',
    task: TASKS[s.task],
    low: lowProviders(s),
    spare: spareProviders(s),
    failed: s.checks !== 'pass',
    failedTwice: s.checks === 'twice',
    budgetLow: s.budget === 'low',
    spent: s.spent,
  }
}

type Truth = boolean | 'maybe'

export function evalToken(
  s: PlaybooksState,
  token: string,
  c: Context,
  subject: CostSubject | null = null,
): Truth {
  const negated = token.startsWith('not ')
  const t = negated ? token.slice(4) : token
  let value: boolean
  let m: RegExpMatchArray | null
  if (t === 'narrow' || t.startsWith('kind:') || EFFORT_CLASSES.includes(t)) {
    if (c.all) return 'maybe'
    if (t === 'narrow') value = Boolean(c.task.narrow)
    else if (t.startsWith('kind:')) value = c.task.kind === t.slice(5)
    else value = c.task.effort === t
  } else if (t === 'both-low' || t === 'all-low')
    value = activeOrder(s).every((p) => c.low.includes(p))
  else if ((m = t.match(s.patterns.state)))
    value = (m[2] === 'low' ? c.low : c.spare).includes(m[1])
  else if ((m = t.match(s.patterns.above))) {
    const win = m[2] ? windowByToken(s, m[1], m[2]) : null
    value = (m[2] ? (win ? usageOf(s, m[1], win.key) : 0) : mainLoad(s, m[1])) >= Number(m[3])
  } else if ((m = t.match(COST_TOKEN))) {
    const price = m[1] === 'price' && subject ? modelPrice(subject.provider, subject.model) : null
    value = m[1] === 'spent' ? c.spent > Number(m[2]) : price !== null && price.input > Number(m[2])
  } else if (t === 'budget-low') value = c.budgetLow
  else if (t === 'checks-failed-twice') value = c.failedTwice
  else if (OUTCOMES.has(t)) value = c.failed
  else value = false
  return negated ? !value : value
}

export function evalCond(
  s: PlaybooksState,
  cond: Cond | undefined | null,
  c: Context,
  subject: CostSubject | null = null,
): Truth {
  let result: Truth = true
  for (const token of condList(cond)) {
    const value = evalToken(s, token, c, subject)
    if (value === false) return false
    if (value === 'maybe') result = 'maybe'
  }
  return result
}

export const isProblemCond = (s: PlaybooksState, cond: Cond | undefined | null) =>
  condList(cond).some((token) => s.patterns.problem.test(token.replace(/^not /, '')))

export const isSpareCond = (cond: Cond | undefined | null) =>
  condList(cond).some((token) => /-spare$/.test(token))

export const tierOf = (s: PlaybooksState, tier: string | null, provider: string): TierUse =>
  tier ? (tiersNow(s)[tier]?.[provider] ?? {}) : {}

export function finalize(s: PlaybooksState, u: Base): ResolvedUse {
  const defaults = tierOf(s, u.tier, u.provider)
  const effort =
    s.catalog[u.provider]?.effort === false ? null : (u.effort ?? defaults.effort ?? null)
  return {
    provider: u.provider,
    tier: u.tier,
    model: u.model ?? defaults.model ?? null,
    effort,
    via: routedVia(s, u.provider),
  }
}

export function applyUse(base: Base, use: PhaseUse = {}): Base {
  const next = { ...base }
  if (use.tier) {
    next.tier = use.tier
    next.model = null
    next.effort = null
  }
  if (use.provider && use.provider !== next.provider) {
    next.provider = use.provider
    next.model = null
  }
  if (use.model) next.model = use.model
  if (use.effort) next.effort = use.effort
  return next
}

const ruleFits = (s: PlaybooksState, rule: PhaseRule, provider: string) =>
  !rule.use?.model ||
  Boolean(rule.use.provider) ||
  [null, provider].includes(modelOwner(s, rule.use.model))

export const supports = (s: PlaybooksState, provider: string, p: Phase) =>
  !p.readOnly || s.catalog[provider]?.readOnly !== false

const leadProvider = (s: PlaybooksState) => inventory(s)[0] ?? 'claude'

const pinOf = (s: PlaybooksState, p: Phase) =>
  p.provider && p.provider !== 'auto' && s.providers.includes(p.provider) ? p.provider : null

export function phaseBase(s: PlaybooksState, p: Phase): Base {
  const provider =
    p.who === 'lead'
      ? leadProvider(s)
      : (pinOf(s, p) ??
        activeOrder(s).find((id) => supports(s, id, p)) ??
        activeOrder(s)[0] ??
        'claude')
  const keepModel = p.model && [null, provider].includes(modelOwner(s, p.model))
  return {
    provider,
    tier: p.tier ?? 'standard',
    model: keepModel ? (p.model ?? null) : null,
    effort: p.effort ?? null,
  }
}

export function nextProvider(
  s: PlaybooksState,
  from: string,
  p: Phase,
  c: Context | null,
): string | null {
  const order = activeOrder(s)
  const start = order.indexOf(from)
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i + order.length) % order.length]
    if (id !== from && supports(s, id, p) && !(c?.low ?? []).includes(id)) return id
  }
  return null
}

export const phaseSubject = (s: PlaybooksState, p: Phase): CostSubject =>
  finalize(s, phaseBase(s, p))

export function resolvePhase(s: PlaybooksState, p: Phase, c: Context): Resolution {
  const lead = p.who === 'lead'
  const base = phaseBase(s, p)
  const subject = finalize(s, base)
  let chosen: Chosen | null = null
  let picked = base
  ;(p.rules ?? []).some((rule, i) => {
    if (!ruleFits(s, rule, base.provider) || evalCond(s, rule.if, c, subject) !== true) return false
    chosen = { i, cond: condList(rule.if), use: rule.use ?? {} }
    picked = applyUse(base, rule.use ?? {})
    return true
  })
  const found = chosen as Chosen | null
  const q = quotaNow(s)
  let switched = false
  let stuck = false
  if (!lead && c.low.includes(picked.provider)) {
    const next =
      found?.use.provider || q.whenLow !== 'switch-provider'
        ? null
        : nextProvider(s, picked.provider, p, c)
    if (next) {
      picked = { ...picked, provider: next, model: null }
      switched = true
    } else stuck = true
  }
  let spent: string | null = null
  const pinnedTo = found?.use.provider ?? pinOf(s, p)
  const spareTo = c.spare.find(
    (provider) =>
      !c.low.includes(provider) &&
      supports(s, provider, p) &&
      (!pinnedTo || picked.provider === provider),
  )
  const spareMode = q.whenSpare ?? 'ignore'
  if (
    !lead &&
    !stuck &&
    spareTo &&
    spareMode !== 'ignore' &&
    !c.budgetLow &&
    !(found && isProblemCond(s, found.cond))
  ) {
    const next: Base =
      spareMode === 'spend-strong'
        ? { provider: spareTo, tier: 'strong', model: null, effort: null }
        : { ...picked, provider: spareTo, model: picked.provider === spareTo ? picked.model : null }
    if (next.provider !== picked.provider || next.tier !== picked.tier) {
      picked = next
      spent = spareTo
    }
  }
  const plannedRule = (p.rules ?? []).find(
    (rule) =>
      ruleFits(s, rule, base.provider) &&
      !isProblemCond(s, rule.if) &&
      evalCond(s, rule.if, c, subject) === true,
  )
  const planned = finalize(s, plannedRule ? applyUse(base, plannedRule.use ?? {}) : base)
  return {
    lead,
    base: finalize(s, base),
    final: finalize(s, picked),
    planned,
    chosen: found,
    switched,
    stuck,
    spent,
  }
}

export function phaseAlts(s: PlaybooksState, p: Phase): Alt[] {
  const base = phaseBase(s, p)
  const alts: Alt[] = []
  ;(p.rules ?? []).forEach((rule, i) => {
    if (ruleFits(s, rule, base.provider))
      alts.push({
        key: `r${i}`,
        cond: condList(rule.if),
        use: finalize(s, applyUse(base, rule.use ?? {})),
        ruleIndex: i,
      })
  })
  const next = nextProvider(s, base.provider, p, null)
  if (
    p.who !== 'lead' &&
    quotaNow(s).whenLow === 'switch-provider' &&
    next &&
    !(p.rules ?? []).some((rule) => condList(rule.if).includes(`${base.provider}-low`))
  ) {
    alts.push({
      key: 'quota',
      cond: [`${base.provider}-low`],
      use: finalize(s, { ...base, provider: next, model: null }),
      implicit: true,
    })
  }
  return alts
}

export const canFallBack = (from: RoutingRoleDef, to: RoutingRoleDef | undefined | null) =>
  to != null && to.name !== from.name && (!from.readOnly || to.readOnly)

export const phaseTitle = (p: Phase) => p.role || p.id

const asUse = (role: RoutingRoleDef): ResolvedUse => ({
  provider: role.agent,
  tier: null,
  model: role.model,
  effort: role.effort,
  via: null,
})

export function resolveRoutingRole(
  wf: RoutingWorkflow,
  roleDef: RoutingRoleDef,
  c: Context,
): { resolved: Resolution; alts: Alt[] } {
  const fallback = roleDef.fallback ? wf.roles.find((r) => r.name === roleDef.fallback) : null
  const base = asUse(roleDef)
  const usable = canFallBack(roleDef, fallback)
  let final = base
  let switched = false
  let stuck = false
  if (c.low.includes(roleDef.agent)) {
    if (usable && fallback && !c.low.includes(fallback.agent)) {
      final = asUse(fallback)
      switched = true
    } else stuck = true
  }
  const alts: Alt[] = fallback
    ? [{ key: 'fallback', cond: [`${roleDef.agent}-low`], use: asUse(fallback), as: fallback.name }]
    : []
  return {
    resolved: {
      lead: false,
      base,
      final,
      planned: base,
      chosen: null,
      switched,
      stuck,
      spent: null,
    },
    alts,
  }
}

export function conditionList(s: PlaybooksState): string[] {
  return [
    ...activeOrder(s).flatMap((p) => [`${p}-low`, `${p}-spare`]),
    'all-low',
    'budget-low',
    'spent-above:5',
    'spent-above:20',
    'price-above:5',
    'price-above:15',
    ...(s.providers.includes('claude')
      ? [
          'claude-opus-above:50',
          'claude-opus-above:80',
          'claude-5h-above:80',
          'claude-week-above:80',
        ]
      : []),
    ...(s.providers.includes('codex') ? ['codex-5h-above:80', 'codex-week-above:80'] : []),
    'deep',
    'standard',
    'light',
    'narrow',
    'not narrow',
    'kind:research',
    'not kind:research',
    'kind:code',
    'kind:review',
    'kind:docs',
    'checks-failed',
    'checks-failed-twice',
    'report-weak',
    'conflict',
    'stuck',
    'no-pass',
    'findings-left',
  ]
}

export const builtInProviders = (s: PlaybooksState) =>
  Object.keys(s.catalog).filter(
    (id) =>
      s.catalog[id].adapter === 'built-in' &&
      (s.providers.includes(id) || id === 'claude' || id === 'codex'),
  )

export const workflowNow = (s: PlaybooksState) => s.workflows[s.wf]

export const isEdited = (s: PlaybooksState) =>
  s.globalEdited || Object.values(s.workflows).some((wf) => wf.edited)

const PB_KEYS = ['name', 'goal', 'pickWhen', 'saves', 'avoidWhen', 'source', 'next', 'phases']
const PHASE_KEYS = [
  'id',
  'role',
  'who',
  'tier',
  'provider',
  'model',
  'effort',
  'readOnly',
  'workers',
  'isolate',
  'runner',
  'with',
  'after',
  'if',
  'then',
  'does',
  'returns',
  'limit',
  'gate',
  'rules',
]

function ordered(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  keys.forEach((k) => {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  })
  Object.keys(obj).forEach((k) => {
    if (!(k in out) && obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  })
  return out
}

export function exportData(s: PlaybooksState): Record<string, unknown> {
  const routing = s.workflows[s.routingWf] as RoutingWorkflow
  const playbooks: Record<string, unknown> = {}
  Object.values(s.workflows).forEach((w) => {
    if (w.kind !== 'playbook') return
    playbooks[w.key] = ordered(
      {
        ...w.pb,
        phases: w.pb.phases.map((p) =>
          ordered(
            {
              ...p,
              rules: p.rules?.length
                ? p.rules.map((rule) => ({ if: rule.if, use: rule.use }))
                : undefined,
            },
            PHASE_KEYS,
          ),
        ),
      },
      PB_KEYS,
    )
  })
  const d = s.data
  return ordered(
    {
      version: 1,
      goal: d.goal ?? 'orchestrate-and-save',
      setup: d.setup,
      principles: d.principles ?? [],
      providers: s.providers,
      models: d.models,
      adapters: d.adapters,
      routes: Object.keys(s.routes).length ? s.routes : undefined,
      tiers: s.tiers,
      quota: s.quota,
      budget: s.budgetRule,
      profile: s.profile,
      profiles: s.profiles,
      pickOrder: d.pickOrder ?? [],
      playbooks,
      routing: {
        basedOn: routing.key,
        roles: routing.roles.map((r) =>
          ordered(
            {
              name: r.name,
              agent: r.agent,
              model: r.model ?? 'default',
              effort: r.effort ?? 'default',
              readOnly: r.readOnly,
              fallback: r.fallback ?? undefined,
            },
            [],
          ),
        ),
        rules: routing.rules.map((r) =>
          ordered(
            {
              when: {
                kinds: r.kinds.length ? r.kinds : undefined,
                efforts: r.efforts.length ? r.efforts : undefined,
              },
              onlyIf: r.gates.length ? r.gates : undefined,
              role: r.role,
            },
            [],
          ),
        ),
      },
      sources: d.sources ?? [],
    },
    [],
  )
}

export const toYaml = (s: PlaybooksState) => emitPlaybooksYaml(exportData(s))
