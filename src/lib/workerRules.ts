import type { RuleSet } from './types'

export const GENERAL_RULE_ID = 'general'

/** Lowercased and stripped of diacritics, mirroring `fold_name` in the core. */
export function foldName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

export function findRuleSet(sets: readonly RuleSet[], name: string): RuleSet | undefined {
  const wanted = foldName(name)
  return sets.find((set) => foldName(set.name) === wanted)
}

export function resolveRuleSets(
  stored: RuleSet[] | null | undefined,
  defaults: RuleSet[],
): RuleSet[] {
  return stored == null ? defaults : stored
}

/** The general set is named in the planner's briefing as always applied: it stays, under that name. */
export function isProtectedRuleSet(set: RuleSet): boolean {
  return set.id === GENERAL_RULE_ID
}

/** How the fetch of Alethe's own sets went. */
export type DefaultRuleSetsStatus = 'loading' | 'ready' | 'failed'

/**
 * What the editor may show and allow.
 *
 * `unavailable` is the one that matters: ours failed to load and the person has no list, so the
 * editor knows nothing — not even General. Rendering that as an empty list would claim a choice
 * the person never made, and letting a set be added there would store a list without General.
 */
export type RuleSetsEditorState = 'loading' | 'unavailable' | 'ready'

export function ruleSetsEditorState(
  stored: RuleSet[] | null | undefined,
  defaultsStatus: DefaultRuleSetsStatus,
): RuleSetsEditorState {
  if (stored != null) return 'ready'
  if (defaultsStatus === 'loading') return 'loading'
  return defaultsStatus === 'failed' ? 'unavailable' : 'ready'
}

/**
 * Whether `name` is already taken by a set other than `selfId`.
 *
 * The core's `find_set` returns the first match, so a second set under the same folded name can
 * never be delivered — the editor refuses the name instead of storing an unreachable set.
 */
export function isDuplicateRuleSetName(
  sets: readonly RuleSet[],
  name: string,
  selfId: string,
): boolean {
  const wanted = foldName(name)
  return sets.some((set) => set.id !== selfId && foldName(set.name) === wanted)
}

/** `base`, or the first `base N` that no existing set answers to. */
export function uniqueRuleSetName(sets: readonly RuleSet[], base: string): string {
  const taken = new Set(sets.map((set) => foldName(set.name)))
  if (!taken.has(foldName(base))) return base
  let suffix = 2
  while (taken.has(foldName(`${base} ${suffix}`))) suffix += 1
  return `${base} ${suffix}`
}
