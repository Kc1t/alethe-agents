import { describe, expect, it } from 'vitest'

import { normalizeOrchestrationTabOrder, normalizeOrchestratorPolicy } from './orchestratorPolicy'
import { DEFAULT_ORCHESTRATOR_POLICY, DEFAULT_ORCHESTRATOR_ROUTING } from './types'

describe('normalizeOrchestratorPolicy', () => {
  it('starts from the defaults when nothing was saved', () => {
    expect(normalizeOrchestratorPolicy(undefined)).toEqual(DEFAULT_ORCHESTRATOR_POLICY)
    expect(normalizeOrchestratorPolicy('garbage')).toEqual(DEFAULT_ORCHESTRATOR_POLICY)
  })

  it('keeps every rule it recognises', () => {
    const saved = {
      defaultAgent: 'claude',
      timeoutMinutes: 0,
      approvals: 'always',
      isolation: 'always',
      webSearch: 'never',
      keepFinished: 0,
      codexSandbox: 'danger-full-access',
      routing: DEFAULT_ORCHESTRATOR_ROUTING,
    }
    expect(normalizeOrchestratorPolicy(saved)).toEqual(saved)
  })

  it('normalizes quota bands and custom routes', () => {
    const normalized = normalizeOrchestratorPolicy({
      routing: {
        preset: 'custom',
        watchPercent: 90,
        protectPercent: 20,
        criticalPercent: 30,
        tiers: {
          light: {
            primary: { agent: 'codex', model: 'fast', effort: 'low' },
            fallback: { agent: 'claude', model: 'haiku', effort: 'low' },
          },
        },
      },
    })
    expect(normalized.routing.watchPercent).toBe(90)
    expect(normalized.routing.protectPercent).toBe(91)
    expect(normalized.routing.criticalPercent).toBe(92)
    // Saved before a tier could chain routes: `{ primary, fallback }` reads as a list of two.
    expect(normalized.routing.tiers.light).toEqual([
      { agent: 'codex', model: 'fast', effort: 'low' },
      { agent: 'claude', model: 'haiku', effort: 'low' },
    ])
  })

  it('does not hand a route on the other CLI the model its preset names', () => {
    const { routing } = normalizeOrchestratorPolicy({
      routing: { preset: 'custom', tiers: { light: [{ agent: 'codex' }] } },
    })
    expect(routing.tiers.light).toEqual([{ agent: 'codex', effort: 'low' }])
    expect(routing.tiers.deep).toEqual(DEFAULT_ORCHESTRATOR_ROUTING.tiers.deep)
  })

  it('keeps a chain in the order it was saved and stops at four routes', () => {
    const chain = [
      { agent: 'claude', model: 'opus', effort: 'high' },
      { agent: 'claude', model: 'sonnet', effort: 'high' },
      { agent: 'codex', effort: 'high' },
      { agent: 'codex', effort: 'medium' },
      { agent: 'claude', model: 'haiku', effort: 'low' },
    ]
    const { routing } = normalizeOrchestratorPolicy({
      routing: { preset: 'custom', tiers: { deep: chain } },
    })
    expect(routing.tiers.deep).toEqual(chain.slice(0, 4))
  })

  it('never leaves a tier without a route', () => {
    const { routing } = normalizeOrchestratorPolicy({
      routing: { preset: 'custom', tiers: { standard: [], deep: ['nonsense', null] } },
    })
    expect(routing.tiers.standard).toEqual(DEFAULT_ORCHESTRATOR_ROUTING.tiers.standard)
    expect(routing.tiers.deep).toEqual(DEFAULT_ORCHESTRATOR_ROUTING.tiers.deep)
  })

  it('never turns an unknown value into a looser rule', () => {
    expect(
      normalizeOrchestratorPolicy({
        defaultAgent: 'gemini',
        timeoutMinutes: 7,
        approvals: 'sometimes',
        isolation: 'never',
        webSearch: 'always',
        keepFinished: 99,
        codexSandbox: 'none',
      }),
    ).toEqual({ ...DEFAULT_ORCHESTRATOR_POLICY, keepFinished: 8 })
  })
})

describe('normalizeOrchestrationTabOrder', () => {
  it('starts in the built-in order', () => {
    expect(normalizeOrchestrationTabOrder(undefined)).toEqual([
      'routing',
      'workers',
      'permissions',
      'models',
    ])
  })

  it('keeps a saved order, dropping what it does not know and adding what is missing', () => {
    expect(normalizeOrchestrationTabOrder(['models', 'nope', 'routing', 'models'])).toEqual([
      'models',
      'routing',
      'workers',
      'permissions',
    ])
  })
})
