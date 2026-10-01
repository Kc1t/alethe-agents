import { describe, expect, it } from 'vitest'

import { legacyGitFeatureFlag, legacyTodosFeatureFlag, normalizeEnabledFeatures } from './features'

describe('normalizeEnabledFeatures', () => {
  it('enables the initial modules for a fresh profile', () => {
    expect(normalizeEnabledFeatures(undefined)).toEqual({
      browser: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
      prs: true,
    })
  })

  it('keeps the defaults for an existing profile', () => {
    expect(normalizeEnabledFeatures({ showGitControl: false })).toEqual({
      browser: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
      prs: true,
    })
  })

  it('preserves explicit modular preferences', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { mcp: false } })).toEqual({
      browser: true,
      aiMemory: false,
      mcp: false,
      playwright: false,
      orchestrator: false,
      prs: true,
    })
  })

  it('keeps AI Memory off unless explicitly enabled', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { aiMemory: true } })).toEqual({
      browser: true,
      aiMemory: true,
      mcp: true,
      playwright: false,
      orchestrator: false,
      prs: true,
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

  it('no longer carries Git, which is a plugin now', () => {
    expect(normalizeEnabledFeatures(undefined)).not.toHaveProperty('git')
    expect(normalizeEnabledFeatures({ enabledFeatures: { git: false } })).not.toHaveProperty('git')
  })

  it('enables Open PRs by default and preserves an explicit choice', () => {
    expect(normalizeEnabledFeatures(undefined).prs).toBe(true)
    expect(normalizeEnabledFeatures({ enabledFeatures: { prs: false } }).prs).toBe(false)
  })
})
