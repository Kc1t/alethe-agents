import { describe, expect, it } from 'vitest'

import { legacyGitFeatureFlag, normalizeEnabledFeatures } from './features'

describe('normalizeEnabledFeatures', () => {
  it('enables the initial modules for a fresh profile', () => {
    expect(normalizeEnabledFeatures(undefined)).toEqual({
      todos: true,
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('keeps Todo off for existing profiles', () => {
    expect(normalizeEnabledFeatures({ showGitControl: false })).toEqual({
      todos: false,
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('preserves explicit modular preferences', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { todos: false } })).toEqual({
      todos: false,
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('keeps AI Memory off unless explicitly enabled', () => {
    expect(
      normalizeEnabledFeatures({ enabledFeatures: { todos: true, aiMemory: true } }),
    ).toEqual({
      todos: true,
      browser: true,
      graphify: true,
      aiMemory: true,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('keeps the Playwright browser off unless explicitly enabled', () => {
    expect(normalizeEnabledFeatures(undefined).playwright, 'it launches a real browser').toBe(false)
    expect(normalizeEnabledFeatures({ enabledFeatures: { playwright: true } }).playwright).toBe(
      true,
    )
  })

  it('keeps orchestration off unless explicitly enabled', () => {
    expect(
      normalizeEnabledFeatures(undefined).orchestrator,
      'it lets the lead agent spawn workers that write to disk',
    ).toBe(false)
    expect(normalizeEnabledFeatures({ enabledFeatures: { orchestrator: true } }).orchestrator).toBe(
      true,
    )
  })

  it('preserves an explicit Graphify preference', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { graphify: false } }).graphify).toBe(false)
  })

  it('no longer carries Git, which is a plugin now', () => {
    expect(normalizeEnabledFeatures(undefined)).not.toHaveProperty('git')
    expect(normalizeEnabledFeatures({ enabledFeatures: { git: false } })).not.toHaveProperty('git')
  })
})

describe('legacyGitFeatureFlag', () => {
  it('reads the modular flag, then the pre-modular one', () => {
    expect(legacyGitFeatureFlag({ enabledFeatures: { git: false } })).toBe(false)
    expect(legacyGitFeatureFlag({ enabledFeatures: { git: true } })).toBe(true)
    expect(legacyGitFeatureFlag({ showGitControl: false })).toBe(false)
  })

  it('is undefined for a profile that never had the feature flag', () => {
    expect(legacyGitFeatureFlag(undefined)).toBeUndefined()
    expect(legacyGitFeatureFlag({ enabledFeatures: { todos: true } })).toBeUndefined()
  })
})
