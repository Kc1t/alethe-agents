import type { MessageKey, TFunction } from '../i18n'
import type { QuotaGateDef, QuotaWindow, RoutingRuleDef, UsagePresetId } from './catalog'
import { formatUsd } from './prices'
import {
  activeOrder,
  type Cond,
  condList,
  COST_TOKEN,
  type PlaybooksState,
  providerLabel,
  quotaNow,
  type ResolvedUse,
  type Spare,
  windowByToken,
} from './state'

const COND_NAMES: Record<string, string> = {
  narrow: 'narrow',
  light: 'light',
  standard: 'standard',
  deep: 'deep',
  'both-low': 'allLow',
  'all-low': 'allLow',
  'budget-low': 'budgetLow',
  'checks-failed': 'checksFailed',
  'checks-failed-twice': 'checksFailedTwice',
  'report-weak': 'reportWeak',
  conflict: 'conflict',
  stuck: 'stuck',
  'no-pass': 'noPass',
  'findings-left': 'findingsLeft',
}

const KIND_KEYS: Record<string, MessageKey> = {
  research: 'playbooks.kind.research',
  code: 'playbooks.kind.code',
  review: 'playbooks.kind.review',
  command: 'playbooks.kind.command',
  scrap: 'playbooks.kind.scrap',
  docs: 'playbooks.kind.docs',
}

const EFFORT_CLASS_KEYS: Record<string, MessageKey> = {
  light: 'playbooks.effortClass.light',
  standard: 'playbooks.effortClass.standard',
  deep: 'playbooks.effortClass.deep',
}

const TIER_KEYS: Record<string, MessageKey> = {
  cheap: 'playbooks.tier.cheap',
  standard: 'playbooks.tier.standard',
  strong: 'playbooks.tier.strong',
}

export const kindLabel = (t: TFunction, kind: string) =>
  KIND_KEYS[kind] ? t(KIND_KEYS[kind]) : kind

export const effortClassLabel = (t: TFunction, effort: string) =>
  EFFORT_CLASS_KEYS[effort] ? t(EFFORT_CLASS_KEYS[effort]) : effort

export const tierLabel = (t: TFunction, tier: string | null | undefined) =>
  tier ? (TIER_KEYS[tier] ? t(TIER_KEYS[tier]) : tier) : ''

export const windowLabel = (t: TFunction, w: QuotaWindow) =>
  t(`playbooks.window.${w.label}` as MessageKey)

export const cycleLabel = (t: TFunction, w: QuotaWindow) =>
  w.cycle ? t(`playbooks.cycle.${w.cycle}` as MessageKey) : windowLabel(t, w)

export const gateWindowLabel = (t: TFunction, window: string) =>
  ['short', 'week', 'opus'].includes(window)
    ? t(`playbooks.gateWindow.${window}` as MessageKey)
    : window

export const hoursText = (t: TFunction, hours: number) =>
  hours % 24 === 0
    ? t('playbooks.daysShort', { count: hours / 24 })
    : t('playbooks.hoursShort', { count: hours })

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export const prettyModel = (model: string) => (/^[a-z]+$/.test(model) ? capitalize(model) : model)

export const modelName = (
  s: PlaybooksState,
  t: TFunction,
  provider: string,
  model: string | null | undefined,
) =>
  model
    ? `${providerLabel(s, provider)} ${prettyModel(model)}`
    : t('playbooks.modelDefault', { provider: providerLabel(s, provider) })

export const shortModel = (
  s: PlaybooksState,
  use: Pick<ResolvedUse, 'provider' | 'model' | 'effort'>,
) =>
  `${use.model ? prettyModel(use.model) : providerLabel(s, use.provider)}${use.effort ? ` · ${use.effort}` : ''}`

function splitToken(token: string): [boolean, string] {
  return token.startsWith('not ') ? [true, token.slice(4)] : [false, token]
}

export function condLabel(s: PlaybooksState, t: TFunction, token: string): string {
  const [negated, bare] = splitToken(token)
  let text: string | null = COND_NAMES[bare]
    ? t(`playbooks.cond.${COND_NAMES[bare]}` as MessageKey)
    : null
  let m: RegExpMatchArray | null
  if (!text && bare.startsWith('kind:'))
    text = t('playbooks.cond.kind', { kind: kindLabel(t, bare.slice(5)) })
  if (!text && (m = bare.match(s.patterns.state)))
    text = t(m[2] === 'low' ? 'playbooks.cond.low' : 'playbooks.cond.spare', {
      provider: providerLabel(s, m[1]),
    })
  if (!text && (m = bare.match(s.patterns.above))) {
    const win = m[2] ? windowByToken(s, m[1], m[2]) : null
    const target = `${providerLabel(s, m[1])}${m[2] ? ` ${win ? windowLabel(t, win) : m[2]}` : ''}`
    text = t('playbooks.cond.above', { target, percent: m[3] })
  }
  if (!text && (m = bare.match(COST_TOKEN)))
    text =
      m[1] === 'price'
        ? t('playbooks.cond.priceAbove', { price: formatUsd(Number(m[2])) })
        : t('playbooks.cond.spentAbove', { amount: formatUsd(Number(m[2])) })
  text = text ?? bare
  return negated ? t('playbooks.cond.not', { condition: text }) : text
}

export function condShort(s: PlaybooksState, t: TFunction, token: string): string {
  const [negated, bare] = splitToken(token)
  let text: string | null = COND_NAMES[bare]
    ? t(`playbooks.condShort.${COND_NAMES[bare]}` as MessageKey)
    : null
  let m: RegExpMatchArray | null
  if (!text && bare.startsWith('kind:')) text = kindLabel(t, bare.slice(5))
  if (!text && (m = bare.match(s.patterns.state)))
    text = t(m[2] === 'low' ? 'playbooks.condShort.low' : 'playbooks.condShort.spare', {
      provider: providerLabel(s, m[1]),
    })
  if (!text && (m = bare.match(s.patterns.above))) {
    const win = m[2] ? windowByToken(s, m[1], m[2]) : null
    const target =
      win?.short ??
      (m[2]
        ? `${providerLabel(s, m[1])} ${win ? windowLabel(t, win) : m[2]}`
        : providerLabel(s, m[1]))
    text = t('playbooks.condShort.above', { target, percent: m[3] })
  }
  if (!text && (m = bare.match(COST_TOKEN)))
    text =
      m[1] === 'price'
        ? t('playbooks.condShort.priceAbove', { price: formatUsd(Number(m[2])) })
        : t('playbooks.condShort.spentAbove', { amount: formatUsd(Number(m[2])) })
  text = text ?? bare
  return negated ? t('playbooks.cond.not', { condition: text }) : text
}

export const condText = (s: PlaybooksState, t: TFunction, cond: Cond | undefined | null) =>
  condList(cond)
    .map((token) => condLabel(s, t, token))
    .join(' + ')

export const condShortText = (s: PlaybooksState, t: TFunction, cond: Cond | undefined | null) =>
  condList(cond)
    .map((token) => condShort(s, t, token))
    .join(' + ')

export function asQuestion(t: TFunction, text: string): string {
  const clean = String(text)
    .trim()
    .replace(/[.?？]+$/, '')
  return t('playbooks.question', { text: capitalize(clean) })
}

export function taskRuleName(t: TFunction, rule: Pick<RoutingRuleDef, 'kinds' | 'efforts'>) {
  const parts: string[] = []
  if (rule.kinds.length) parts.push(rule.kinds.map((kind) => kindLabel(t, kind)).join(' · '))
  if (rule.efforts.length)
    parts.push(rule.efforts.map((effort) => effortClassLabel(t, effort)).join(' / '))
  return parts.length ? parts.join(' · ') : t('playbooks.anythingElse')
}

export const gateName = (s: PlaybooksState, t: TFunction, gate: QuotaGateDef) =>
  t('playbooks.gateName', {
    provider: providerLabel(s, gate.agent),
    window: gateWindowLabel(t, gate.window),
    below: gate.below,
  })

const WHEN_LOW: Record<string, MessageKey> = {
  'switch-provider': 'playbooks.whenLow.switch',
  keep: 'playbooks.whenLow.keep',
}
const ALL_LOW: Record<string, MessageKey> = {
  ask: 'playbooks.allLow.ask',
  'run-cheapest': 'playbooks.allLow.runCheapest',
  block: 'playbooks.allLow.block',
}
const WHEN_SPARE: Record<string, MessageKey> = {
  'spend-strong': 'playbooks.whenSpare.spendStrong',
  prefer: 'playbooks.whenSpare.prefer',
  ignore: 'playbooks.whenSpare.ignore',
}
const BUDGET_LOW: Record<string, MessageKey> = {
  'finish-and-report': 'playbooks.budgetLow.finish',
  'downgrade-tier': 'playbooks.budgetLow.downgrade',
  stop: 'playbooks.budgetLow.stop',
}

const option = (t: TFunction, keys: Record<string, MessageKey>, value: string) =>
  keys[value] ? t(keys[value]) : value

export const whenLowOptions = (t: TFunction) =>
  Object.keys(WHEN_LOW).map((value) => ({ value, label: option(t, WHEN_LOW, value) }))
export const allLowOptions = (t: TFunction) =>
  Object.keys(ALL_LOW).map((value) => ({ value, label: option(t, ALL_LOW, value) }))
export const whenSpareOptions = (t: TFunction) =>
  Object.keys(WHEN_SPARE).map((value) => ({ value, label: option(t, WHEN_SPARE, value) }))
export const budgetLowOptions = (t: TFunction) =>
  Object.keys(BUDGET_LOW).map((value) => ({ value, label: option(t, BUDGET_LOW, value) }))

export function globalRuleLines(s: PlaybooksState, t: TFunction): string[] {
  const q = quotaNow(s)
  const b = s.budgetRule
  return [
    t('playbooks.ruleLine.low', {
      percent: q.criticalThreshold,
      action: option(t, WHEN_LOW, q.whenLow === 'switch-provider' ? q.whenLow : 'keep'),
    }),
    t('playbooks.ruleLine.allLow', { action: option(t, ALL_LOW, q.onBothCritical) }),
    t('playbooks.ruleLine.spare', { action: option(t, WHEN_SPARE, q.whenSpare) }),
    t('playbooks.ruleLine.budget', { percent: b.warnAt, action: option(t, BUDGET_LOW, b.whenLow) }),
  ]
}

export function spareWhy(t: TFunction, spare: Spare): string {
  const cycle = cycleLabel(t, spare.cycle)
  if (spare.reason === 'reset')
    return t('playbooks.spareWhy.reset', { cycle, time: hoursText(t, spare.hours) })
  return spare.reset === null
    ? t('playbooks.spareWhy.plan', { cycle, days: spare.days })
    : t('playbooks.spareWhy.planReset', {
        cycle,
        days: spare.days,
        time: hoursText(t, spare.reset),
      })
}

const USAGE_PRESET_KEYS: Record<UsagePresetId | 'custom', MessageKey> = {
  now: 'playbooks.usagePreset.now',
  plenty: 'playbooks.usagePreset.plenty',
  'claude-5h': 'playbooks.usagePreset.claude5h',
  'claude-week': 'playbooks.usagePreset.claudeWeek',
  'codex-out': 'playbooks.usagePreset.codexOut',
  'all-out': 'playbooks.usagePreset.allOut',
  'codex-ending': 'playbooks.usagePreset.codexEnding',
  'claude-reset': 'playbooks.usagePreset.claudeReset',
  'kiro-reset': 'playbooks.usagePreset.kiroReset',
  custom: 'playbooks.usagePreset.custom',
}

export const usagePresetLabel = (t: TFunction, key: UsagePresetId | 'custom') =>
  t(USAGE_PRESET_KEYS[key])

export const providerOrderText = (s: PlaybooksState) =>
  activeOrder(s)
    .map((id) => providerLabel(s, id))
    .join(' → ')
