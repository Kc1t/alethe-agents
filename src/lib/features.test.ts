import { describe, expect, it } from 'vitest'

import { normalizeEnabledFeatures } from './features'

describe('normalizeEnabledFeatures', () => {
  it('enables the initial modules for a fresh profile', () => {
    expect(normalizeEnabledFeatures(undefined)).toEqual({
      todos: true,
      git: true,
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('preserves legacy Git and keeps Todo off for existing profiles', () => {
    expect(normalizeEnabledFeatures({ showGitControl: false })).toEqual({
      todos: false,
      git: false,
      browser: true,
      graphify: true,
      aiMemory: false,
      mcp: true,
      playwright: false,
      orchestrator: false,
    })
  })

  it('preserves explicit modular preferences', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { todos: false, git: true } })).toEqual({
      todos: false,
      git: true,
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
      normalizeEnabledFeatures({ enabledFeatures: { todos: true, git: true, aiMemory: true } }),
    ).toEqual({
      todos: true,
      git: true,
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
})
