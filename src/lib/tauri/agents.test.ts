import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve('hooks.json')),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

let aiMemoryEnabled = true
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      preferences: { enabledFeatures: { aiMemory: aiMemoryEnabled } },
    }),
  },
}))

import { agentHooksSettingsPath } from './agents'

describe('agentHooksSettingsPath', () => {
  beforeEach(() => {
    invoke.mockClear()
    aiMemoryEnabled = true
  })

  it('with no third argument, defaults to the live preference when it is on', async () => {
    aiMemoryEnabled = true
    await agentHooksSettingsPath('p', true)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ aiMemoryEnabled: true }),
    )
  })

  it('with no third argument, defaults to the live preference when it is off', async () => {
    aiMemoryEnabled = false
    await agentHooksSettingsPath('p', true)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ aiMemoryEnabled: false }),
    )
  })

  it('an explicit null opts a caller out regardless of the live preference, like the demo sandbox', async () => {
    aiMemoryEnabled = true
    await agentHooksSettingsPath('sandbox-demo', true, null)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ aiMemoryEnabled: false }),
    )
  })
})
