import { describe, expect, it } from 'vitest'

import {
  applyLaunchDefaults,
  effortLevelsFor,
  effortLevelsForModel,
  isValidModelName,
  normalizeLaunchDefaults,
  resolveLaunchDefaults,
  supportsModelDefault,
} from './agentLaunchDefaults'
import { buildAgentLaunch } from './sessionLaunch'
import type { AgentDefaultsPreferences } from './types'

const preferences: AgentDefaultsPreferences = {
  providers: {
    claude: { model: 'sonnet', effort: 'medium' },
    codex: { model: 'gpt-5.6-sol' },
  },
  planner: { claude: { model: 'opus', effort: 'high' } },
  worker: { claude: { effort: 'low' }, codex: { effort: 'high' } },
}

describe('resolveLaunchDefaults', () => {
  it('uses the provider default for an ordinary pane', () => {
    expect(resolveLaunchDefaults(preferences, 'claude')).toEqual({
      model: 'sonnet',
      effort: 'medium',
    })
  })

  it('lets a role override the provider default field by field', () => {
    expect(resolveLaunchDefaults(preferences, 'claude', 'planner')).toEqual({
      model: 'opus',
      effort: 'high',
    })
    expect(resolveLaunchDefaults(preferences, 'claude', 'worker')).toEqual({
      model: 'sonnet',
      effort: 'low',
    })
    expect(resolveLaunchDefaults(preferences, 'codex', 'worker')).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
  })

  it('returns nothing when there are no preferences or the provider has no flags', () => {
    expect(resolveLaunchDefaults(undefined, 'claude')).toEqual({})
    expect(
      resolveLaunchDefaults({ ...preferences, providers: { kimi: { model: 'k2' } } }, 'kimi'),
    ).toEqual({})
  })
})

describe('normalizeLaunchDefaults', () => {
  it('drops a model name that could not be a single safe argv token', () => {
    expect(normalizeLaunchDefaults('claude', { model: 'opus; rm -rf ~' })).toEqual({})
    expect(normalizeLaunchDefaults('claude', { model: '--dangerous' })).toEqual({})
    expect(normalizeLaunchDefaults('claude', { model: '  opus[1m]  ' })).toEqual({
      model: 'opus[1m]',
    })
    expect(normalizeLaunchDefaults('opencode', { model: 'anthropic/claude-sonnet-5-5' })).toEqual({
      model: 'anthropic/claude-sonnet-5-5',
    })
  })

  it('drops an effort the provider does not accept', () => {
    expect(normalizeLaunchDefaults('codex', { effort: 'extreme' })).toEqual({})
    // Newer Codex models go past `high`, and what each takes comes from its own model list.
    expect(normalizeLaunchDefaults('codex', { effort: 'ultra' })).toEqual({ effort: 'ultra' })
    expect(normalizeLaunchDefaults('opencode', { effort: 'high' })).toEqual({})
    expect(normalizeLaunchDefaults('claude', { effort: 'max' })).toEqual({ effort: 'max' })
  })
})

describe('provider capabilities', () => {
  it('offers effort only where the CLI has a way to take it', () => {
    expect(effortLevelsFor('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevelsFor('codex')).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    expect(effortLevelsFor('opencode')).toEqual([])
    expect(supportsModelDefault('opencode')).toBe(true)
    expect(supportsModelDefault('shell')).toBe(false)
  })

  it('accepts real model ids and rejects anything with shell syntax', () => {
    expect(isValidModelName('claude-opus-5-5')).toBe(true)
    expect(isValidModelName('gpt-5:latest')).toBe(true)
    expect(isValidModelName('a b')).toBe(false)
    expect(isValidModelName("x'y")).toBe(false)
    expect(isValidModelName('')).toBe(false)
  })
})

describe('applyLaunchDefaults', () => {
  it('appends each provider in its own syntax', () => {
    expect(applyLaunchDefaults('claude', [], { model: 'opus', effort: 'high' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'high',
    ])
    expect(applyLaunchDefaults('codex', [], { model: 'gpt-5.6-sol', effort: 'high' })).toEqual([
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort=high',
    ])
    expect(applyLaunchDefaults('opencode', [], { model: 'anthropic/claude-sonnet-5-5' })).toEqual([
      '--model',
      'anthropic/claude-sonnet-5-5',
    ])
  })

  it('leaves the arguments alone without defaults or for a provider with no flags', () => {
    expect(applyLaunchDefaults('claude', ['--foo'], undefined)).toEqual(['--foo'])
    expect(applyLaunchDefaults('claude', ['--foo'], {})).toEqual(['--foo'])
    expect(applyLaunchDefaults('shell', ['-l'], { model: 'opus' })).toEqual(['-l'])
  })

  it('never overrides a model or effort the tab already carries', () => {
    const defaults = { model: 'opus', effort: 'high' } as const
    expect(applyLaunchDefaults('claude', ['--model', 'haiku'], defaults)).toEqual([
      '--model',
      'haiku',
      '--effort',
      'high',
    ])
    expect(applyLaunchDefaults('claude', ['--model=haiku', '--effort', 'low'], defaults)).toEqual([
      '--model=haiku',
      '--effort',
      'low',
    ])
    expect(applyLaunchDefaults('codex', ['-m', 'o3'], defaults)).toEqual([
      '-m',
      'o3',
      '--config',
      'model_reasoning_effort=high',
    ])
    expect(
      applyLaunchDefaults(
        'codex',
        ['-c', 'model=o3', '-c', 'model_reasoning_effort=low'],
        defaults,
      ),
    ).toEqual(['-c', 'model=o3', '-c', 'model_reasoning_effort=low'])
  })

  it('survives the session arguments each provider adds on resume', () => {
    const claude = applyLaunchDefaults('claude', [], { model: 'opus', effort: 'high' })
    expect(buildAgentLaunch('claude', claude, 'session-1').args).toEqual([
      '--resume',
      'session-1',
      '--model',
      'opus',
      '--effort',
      'high',
    ])

    const codex = applyLaunchDefaults('codex', [], { model: 'gpt-5.6-sol', effort: 'high' })
    expect(buildAgentLaunch('codex', codex, 'thread-1').args).toEqual([
      'resume',
      'thread-1',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort=high',
    ])

    const opencode = applyLaunchDefaults('opencode', [], { model: 'anthropic/claude-sonnet-5-5' })
    expect(buildAgentLaunch('opencode', opencode, 'ses_1').args).toEqual([
      '--session',
      'ses_1',
      '--model',
      'anthropic/claude-sonnet-5-5',
    ])
  })
})

describe('effortLevelsForModel', () => {
  const codexModels = [
    {
      id: 'gpt-5.6-sol',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      isDefault: true,
    },
    { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ]

  it('offers what the chosen model advertises', () => {
    expect(effortLevelsForModel('codex', 'gpt-5.5', codexModels)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('follows the CLI default model when none is chosen', () => {
    expect(effortLevelsForModel('codex', undefined, codexModels)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
  })

  it('falls back to what every model takes when the model is unknown', () => {
    expect(effortLevelsForModel('codex', 'my-proxy-model', codexModels)).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(effortLevelsForModel('claude', 'opus', [])).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  it('offers nothing for a model that takes no effort', () => {
    expect(effortLevelsForModel('claude', 'haiku', [{ id: 'haiku', efforts: [] }])).toEqual([])
  })

  it('keeps a saved level visible even when the model does not advertise it', () => {
    expect(effortLevelsForModel('codex', 'gpt-5.5', codexModels, 'ultra')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra',
    ])
  })
})
