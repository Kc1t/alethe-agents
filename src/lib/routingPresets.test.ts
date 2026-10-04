import { describe, expect, it } from 'vitest'

import { isValidRole, isValidRoutingRule } from './orchestrationSettings'
import { applyRoutingPreset, ROUTING_PRESET_IDS, ROUTING_PRESETS } from './routingPresets'
import type { OrchestrationRole } from './types'

describe('routing presets', () => {
  it('ships the three presets', () => {
    expect(ROUTING_PRESET_IDS).toEqual(['economy', 'balanced', 'performance'])
  })

  it.each(ROUTING_PRESET_IDS)('%s has only valid roles and rules', (presetId) => {
    const preset = ROUTING_PRESETS[presetId]
    for (const presetRole of preset.roles) expect(isValidRole(presetRole)).toBe(true)
    for (const rule of preset.rules) expect(isValidRoutingRule({ ...rule, id: 'x' })).toBe(true)
  })

  it.each(ROUTING_PRESET_IDS)('%s rules only reference roles the preset ships', (presetId) => {
    const preset = ROUTING_PRESETS[presetId]
    const names = new Set(preset.roles.map((presetRole) => presetRole.name))
    for (const rule of preset.rules) expect(names.has(rule.role)).toBe(true)
  })

  it.each(ROUTING_PRESET_IDS)('%s role fallbacks resolve inside the preset', (presetId) => {
    const preset = ROUTING_PRESETS[presetId]
    const names = new Set(preset.roles.map((presetRole) => presetRole.name))
    for (const presetRole of preset.roles) {
      if (presetRole.fallback) expect(names.has(presetRole.fallback)).toBe(true)
    }
  })

  it('applyRoutingPreset keeps unrelated user roles and gives rules fresh ids', () => {
    const custom: OrchestrationRole = {
      name: 'my-role',
      agent: 'claude',
      model: 'sonnet',
      effort: null,
      readOnly: false,
      timeoutSeconds: 60,
    }
    const { roles, rules } = applyRoutingPreset('balanced', [custom])
    expect(roles.some((role) => role.name === 'my-role')).toBe(true)
    expect(rules.length).toBe(ROUTING_PRESETS.balanced.rules.length)
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length)
  })

  it('applyRoutingPreset lets the preset redefine its own role names', () => {
    const tuned: OrchestrationRole = {
      name: 'builder',
      agent: 'codex',
      model: null,
      effort: 'low',
      readOnly: false,
      timeoutSeconds: null,
    }
    const { roles } = applyRoutingPreset('balanced', [tuned])
    const builder = roles.find((role) => role.name === 'builder')
    expect(builder?.agent).toBe('claude')
    expect(roles.filter((role) => role.name === 'builder')).toHaveLength(1)
  })
})
