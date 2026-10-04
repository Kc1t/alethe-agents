import { nanoid } from 'nanoid'

import type { OrchestrationRole, RoutingPresetId, RoutingRule } from './types'

/** A preset ships the roles its rules point at plus the rules themselves (ids minted on apply). */
export type RoutingPreset = {
  roles: OrchestrationRole[]
  rules: Array<Omit<RoutingRule, 'id'>>
}

const role = (
  name: string,
  agent: OrchestrationRole['agent'],
  model: string | null,
  effort: string | null,
  readOnly: boolean,
  fallback?: string,
): OrchestrationRole => ({
  name,
  agent,
  model,
  effort,
  readOnly,
  timeoutSeconds: null,
  ...(fallback ? { fallback } : {}),
})

export const ROUTING_PRESETS: Record<Exclude<RoutingPresetId, 'custom'>, RoutingPreset> = {
  economy: {
    roles: [
      role('scout', 'claude', 'haiku', 'low', false, 'handyman'),
      role('handyman', 'codex', null, 'low', true),
      role('builder', 'codex', null, 'medium', false, 'scout'),
    ],
    rules: [
      { enabled: true, kinds: ['research', 'scrap', 'docs'], efforts: [], gates: [], role: 'scout' },
      { enabled: true, kinds: [], efforts: ['light'], gates: [], role: 'scout' },
      { enabled: true, kinds: ['review'], efforts: [], gates: [], role: 'handyman' },
      { enabled: true, kinds: [], efforts: ['standard', 'deep'], gates: [], role: 'builder' },
    ],
  },
  balanced: {
    roles: [
      role('scout', 'claude', 'haiku', 'low', false, 'handyman'),
      role('handyman', 'codex', null, 'low', true),
      role('builder', 'claude', 'sonnet', 'medium', false, 'codex-builder'),
      role('codex-builder', 'codex', null, 'medium', false),
      role('expert', 'claude', 'opus', 'high', false, 'builder'),
    ],
    rules: [
      { enabled: true, kinds: ['research', 'scrap', 'docs'], efforts: [], gates: [], role: 'scout' },
      { enabled: true, kinds: [], efforts: ['light'], gates: [], role: 'scout' },
      { enabled: true, kinds: ['review'], efforts: [], gates: [], role: 'handyman' },
      {
        enabled: true,
        kinds: [],
        efforts: ['deep'],
        gates: [{ agent: 'claude', window: 'opus', below: 50 }],
        role: 'expert',
      },
      { enabled: true, kinds: [], efforts: [], gates: [], role: 'builder' },
    ],
  },
  performance: {
    roles: [
      role('builder', 'claude', 'sonnet', 'medium', false, 'codex-builder'),
      role('codex-builder', 'codex', null, 'medium', false),
      role('expert', 'claude', 'opus', 'high', false, 'builder'),
    ],
    rules: [
      { enabled: true, kinds: [], efforts: ['light'], gates: [], role: 'builder' },
      {
        enabled: true,
        kinds: [],
        efforts: ['deep'],
        gates: [{ agent: 'claude', window: 'opus', below: 80 }],
        role: 'expert',
      },
      { enabled: true, kinds: [], efforts: [], gates: [], role: 'builder' },
    ],
  },
}

export const ROUTING_PRESET_IDS = Object.keys(ROUTING_PRESETS) as Array<
  Exclude<RoutingPresetId, 'custom'>
>

/**
 * The roles and rules applying a preset produces. Preset-owned role names take the preset's
 * definition — a preset must mean what it says — while roles the preset does not know about are
 * kept untouched. Rules are replaced wholesale and get fresh ids.
 */
export function applyRoutingPreset(
  presetId: Exclude<RoutingPresetId, 'custom'>,
  currentRoles: readonly OrchestrationRole[],
): { roles: OrchestrationRole[]; rules: RoutingRule[] } {
  const preset = ROUTING_PRESETS[presetId]
  const owned = new Set(preset.roles.map((presetRole) => presetRole.name))
  return {
    roles: [...preset.roles, ...currentRoles.filter((current) => !owned.has(current.name))],
    rules: preset.rules.map((rule) => ({ ...rule, id: nanoid(8) })),
  }
}
