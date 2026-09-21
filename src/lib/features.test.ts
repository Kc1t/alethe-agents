import { describe, expect, it } from 'vitest'

import {
  legacyGitFeatureFlag,
  legacyTodosFeatureFlag,
  normalizeEnabledFeatures,
} from './features'

describe('normalizeEnabledFeatures', () => {
  it('enables the initial modules for a fresh profile', () => {
    expect(normalizeEnabledFeatures(undefined)).toEqual({
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
      gsdSync: false,
      prs: true,
    })
  })

  it('keeps the defaults for an existing profile', () => {
    expect(normalizeEnabledFeatures({ showGitControl: false })).toEqual({
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
      gsdSync: false,
      prs: true,
    })
  })

  it('preserves explicit modular preferences', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { graphify: false } })).toEqual({
      browser: true,
      graphify: false,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
      gsdSync: false,
      prs: true,
    })
  })

  it('keeps AI Memory off unless explicitly enabled', () => {
    expect(
      normalizeEnabledFeatures({ enabledFeatures: { aiMemory: true } }),
    ).toEqual({
      browser: true,
      graphify: true,
      aiMemory: true,
      mcp: true,
      playwright: false,
      orchestrator: false,
      gsdSync: false,
      prs: true,
    })
  })

  it('keeps the Playwright browser off unless explicitly enabled', () => {
    expect(normalizeEnabledFeatures(undefined).playwright, 'it launches a real browser').toBe(false)
    expect(normalizeEnabledFeatures({ enabledFeatures: { playwright: true } }).playwright).toBe(
      true,
    )
  })

  it('keeps GSD Sync off unless explicitly enabled', () => {
    expect(normalizeEnabledFeatures(undefined).gsdSync, 'OpenCode-only, and it polls').toBe(false)
    expect(normalizeEnabledFeatures({ enabledFeatures: { gsdSync: true } }).gsdSync).toBe(true)
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

  it('enables Open PRs by default and preserves an explicit choice', () => {
    expect(normalizeEnabledFeatures(undefined).prs).toBe(true)
    expect(normalizeEnabledFeatures({ enabledFeatures: { prs: false } }).prs).toBe(false)
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

describe('legacyTodosFeatureFlag', () => {
  it('carries an explicit choice over to the plugin', () => {
    expect(legacyTodosFeatureFlag({ enabledFeatures: { todos: false } })).toBe(false)
    expect(legacyTodosFeatureFlag({ enabledFeatures: { todos: true } })).toBe(true)
  })

  it('leaves a fresh profile at the plugin default', () => {
    expect(legacyTodosFeatureFlag(undefined)).toBeUndefined()
  })

  it('keeps Todo off for a profile that predates the feature flag', () => {
    // It used to be on only for fresh profiles; undefined here would switch the
    // tab on for someone who never had it.
    expect(legacyTodosFeatureFlag({ showGitControl: false })).toBe(false)
  })
})
