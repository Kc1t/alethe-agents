import { describe, expect, it } from 'vitest'

import {
  AGENT_TYPE_LABELS,
  agentCliCommand,
  ALL_AGENT_TYPES,
  DEFAULT_PREFERENCES,
  PROVIDER_MODELS,
  UNRESTRICTED_FLAG,
} from './types'

describe('Hermes agent registration', () => {
  it('registers Hermes as a normal enabled CLI agent', () => {
    expect(ALL_AGENT_TYPES).toContain('hermes')
    expect(AGENT_TYPE_LABELS.hermes).toBe('Hermes Agent')
    expect(agentCliCommand('hermes')).toBe('hermes')
    expect(DEFAULT_PREFERENCES.enabledAgents.hermes).toBe(true)
  })

  it('uses Hermes unrestricted mode without inventing provider models', () => {
    expect(UNRESTRICTED_FLAG.hermes).toBe('--yolo')
    expect(PROVIDER_MODELS.hermes).toEqual([])
  })
})
