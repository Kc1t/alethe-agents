import { beforeEach, describe, expect, it } from 'vitest'

import {
  collapsedSections,
  isSectionCollapsed,
  parseCollapsedSections,
  resetCollapsedSectionsCache,
  setSectionCollapsed,
  subscribeCollapsedSections,
} from './settingsSections'

describe('which sections are folded away', () => {
  it('uses the page default only while the person has never touched the section', () => {
    expect(isSectionCollapsed({}, 'multiagent-metrics', true)).toBe(true)
    expect(isSectionCollapsed({}, 'multiagent-rules', false)).toBe(false)
  })

  it('lets the person override the default in both directions', () => {
    // A section that ships folded must stay open once opened — otherwise every visit re-hides the
    // thing the person just said they wanted to see.
    expect(isSectionCollapsed({ 'multiagent-metrics': false }, 'multiagent-metrics', true)).toBe(
      false,
    )
    expect(isSectionCollapsed({ 'multiagent-rules': true }, 'multiagent-rules', false)).toBe(true)
  })
})

describe('reading what was stored', () => {
  it('survives an entry that is missing, corrupt or the wrong shape', () => {
    expect(parseCollapsedSections(null)).toEqual({})
    expect(parseCollapsedSections('not json')).toEqual({})
    expect(parseCollapsedSections('[1,2]')).toEqual({})
    expect(parseCollapsedSections('"a string"')).toEqual({})
  })

  it('keeps only the booleans it understands', () => {
    expect(parseCollapsedSections('{"a":true,"b":"yes","c":false}')).toEqual({ a: true, c: false })
  })
})

describe('storing a choice', () => {
  beforeEach(() => {
    localStorage.clear()
    resetCollapsedSectionsCache()
  })

  it('remembers a fold across a fresh read', () => {
    setSectionCollapsed('multiagent-traces', true)
    resetCollapsedSectionsCache()
    expect(collapsedSections()).toEqual({ 'multiagent-traces': true })
  })

  it('tells every open panel that a section moved', () => {
    let told = 0
    const stop = subscribeCollapsedSections(() => {
      told += 1
    })
    setSectionCollapsed('multiagent-audit', true)
    expect(told).toBe(1)
    stop()
    setSectionCollapsed('multiagent-audit', false)
    expect(told).toBe(1)
  })
})
