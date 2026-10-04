import { describe, expect, it } from 'vitest'

import {
  normalizeOrchestrationSettings,
  normalizeRoutingSettings,
} from './orchestrationSettings'
import { DEFAULT_ROUTING_SETTINGS } from './types'

const validRule = {
  id: 'r1',
  enabled: true,
  kinds: ['research'],
  efforts: ['light'],
  gates: [{ agent: 'claude', window: 'week', below: 50 }],
  role: 'scout',
}

describe('normalizeRoutingSettings', () => {
  it('falls back to the defaults when the stored value is garbage', () => {
    expect(normalizeRoutingSettings(undefined)).toEqual(DEFAULT_ROUTING_SETTINGS)
    expect(normalizeRoutingSettings('nope')).toEqual(DEFAULT_ROUTING_SETTINGS)
  })

  it('keeps a valid rule untouched', () => {
    const result = normalizeRoutingSettings({ preset: 'economy', rules: [validRule] })
    expect(result.preset).toBe('economy')
    expect(result.rules).toEqual([validRule])
  })

  it('keeps a rule whose role does not exist yet', () => {
    const result = normalizeRoutingSettings({ rules: [validRule] })
    expect(result.rules).toHaveLength(1)
  })

  it('drops rules with unknown kinds, bad gates or duplicate ids', () => {
    const result = normalizeRoutingSettings({
      rules: [
        validRule,
        { ...validRule, id: 'r2', kinds: ['hack-the-planet'] },
        { ...validRule, id: 'r3', gates: [{ agent: 'claude', window: 'week', below: 0 }] },
        { ...validRule, id: 'r4', role: 'has whitespace' },
        validRule,
      ],
    })
    expect(result.rules.map((rule) => rule.id)).toEqual(['r1'])
  })

  it('clamps the critical threshold and rejects junk enum values', () => {
    expect(normalizeRoutingSettings({ criticalThreshold: 3 }).criticalThreshold).toBe(80)
    expect(normalizeRoutingSettings({ criticalThreshold: 75 }).criticalThreshold).toBe(75)
    expect(normalizeRoutingSettings({ preset: 'wild' }).preset).toBe('balanced')
    expect(normalizeRoutingSettings({ onBothCritical: 'yolo' }).onBothCritical).toBe('ask')
  })
})

describe('normalizeOrchestrationSettings', () => {
  it('adds default routing settings to settings stored before routing existed', () => {
    const result = normalizeOrchestrationSettings({ roles: [], maxConcurrent: 4 })
    expect(result.routing).toEqual(DEFAULT_ROUTING_SETTINGS)
  })

  it('normalizes routing stored alongside the roles', () => {
    const result = normalizeOrchestrationSettings({
      roles: [],
      routing: { preset: 'performance', rules: [validRule], criticalThreshold: 90 },
    })
    expect(result.routing.preset).toBe('performance')
    expect(result.routing.rules).toEqual([validRule])
    expect(result.routing.criticalThreshold).toBe(90)
  })
})
