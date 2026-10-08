import { describe, expect, it } from 'vitest'

import {
  findRuleSet,
  foldName,
  GENERAL_RULE_ID,
  isDuplicateRuleSetName,
  isProtectedRuleSet,
  resolveRuleSets,
  ruleSetsEditorState,
  uniqueRuleSetName,
} from './workerRules'
import type { RuleSet } from './types'

const ours: RuleSet[] = [
  { id: GENERAL_RULE_ID, name: 'General', text: 'g' },
  { id: 'backend', name: 'Backend', text: 'b' },
]

describe('resolveRuleSets', () => {
  it('uses ours only when nothing was ever stored', () => {
    expect(resolveRuleSets(null, ours)).toEqual(ours)
    expect(resolveRuleSets(undefined, ours)).toEqual(ours)
  })

  it('honours an empty list as a deliberate choice', () => {
    // The shortcuts learned this the hard way: treating [] as "use ours" makes deleting the last
    // one resurrect everything.
    expect(resolveRuleSets([], ours)).toEqual([])
  })

  it('returns the stored list untouched', () => {
    const mine: RuleSet[] = [{ id: 'x', name: 'Mine', text: 'm' }]
    expect(resolveRuleSets(mine, ours)).toEqual(mine)
  })
})

describe('findRuleSet', () => {
  it('matches regardless of case and accents', () => {
    const sets: RuleSet[] = [{ id: 'db', name: 'Banco de Dados', text: 's' }]
    expect(findRuleSet(sets, 'banco de dados')?.id).toBe('db')
    expect(findRuleSet(sets, 'BANCO DE DADOS')?.id).toBe('db')
    expect(findRuleSet(sets, 'banco')).toBeUndefined()
  })

  it('folds the same way the core does', () => {
    expect(foldName('  Configuração ')).toBe('configuracao')
  })
})

describe('the general set is protected', () => {
  it('cannot be deleted or renamed, and every other set can', () => {
    // The planner is told "General always applies"; a renamed or missing General would make that
    // briefing a lie.
    expect(isProtectedRuleSet(ours[0])).toBe(true)
    expect(isProtectedRuleSet(ours[1])).toBe(false)
  })
})

describe('ruleSetsEditorState', () => {
  it('waits while ours are still loading and nothing is stored', () => {
    expect(ruleSetsEditorState(null, 'loading')).toBe('loading')
  })

  it('reports ours as unavailable when the fetch failed and nothing is stored', () => {
    // An empty editor here would read as "the person chose to have none" while the core is still
    // serving ours — the screen would contradict what the workers actually receive.
    expect(ruleSetsEditorState(null, 'failed')).toBe('unavailable')
    expect(ruleSetsEditorState(undefined, 'failed')).toBe('unavailable')
  })

  it('is ready once ours arrived', () => {
    expect(ruleSetsEditorState(null, 'ready')).toBe('ready')
  })

  it('is ready whenever a list is stored, however the fetch went', () => {
    // The person's own list needs none of ours to be editable, empty list included.
    expect(ruleSetsEditorState([], 'failed')).toBe('ready')
    expect(ruleSetsEditorState([], 'loading')).toBe('ready')
    expect(ruleSetsEditorState(ours, 'failed')).toBe('ready')
  })
})

describe('isDuplicateRuleSetName', () => {
  const sets: RuleSet[] = [
    { id: GENERAL_RULE_ID, name: 'General', text: 'g' },
    { id: 'db', name: 'Banco de Dados', text: 's' },
  ]

  it('folds case and accents the way the core does', () => {
    expect(isDuplicateRuleSetName(sets, 'general', 'db')).toBe(true)
    expect(isDuplicateRuleSetName(sets, 'BANCO DE DADOS', 'other')).toBe(true)
    expect(isDuplicateRuleSetName(sets, 'banco de dados', 'other')).toBe(true)
  })

  it('does not count a set against itself', () => {
    // Renaming a set to the name it already has is not a duplicate.
    expect(isDuplicateRuleSetName(sets, 'Banco de Dados', 'db')).toBe(false)
    expect(isDuplicateRuleSetName(sets, 'banco de dados', 'db')).toBe(false)
  })

  it('accepts a free name', () => {
    expect(isDuplicateRuleSetName(sets, 'Frontend', 'db')).toBe(false)
  })
})

describe('uniqueRuleSetName', () => {
  it('returns the base name when it is free', () => {
    expect(uniqueRuleSetName(ours, 'New set')).toBe('New set')
  })

  it('numbers past every taken name so adding twice never collides', () => {
    // "Add set" twice in a row is the obvious thing to do; the second one must not be born
    // undeliverable behind the first.
    const taken: RuleSet[] = [
      { id: 'a', name: 'New set', text: '' },
      { id: 'b', name: 'new SET 2', text: '' },
    ]
    expect(uniqueRuleSetName(taken, 'New set')).toBe('New set 3')
  })

  it('folds accents when looking for a free name', () => {
    const taken: RuleSet[] = [{ id: 'a', name: 'Configuração', text: '' }]
    expect(uniqueRuleSetName(taken, 'Configuracao')).toBe('Configuracao 2')
  })
})
