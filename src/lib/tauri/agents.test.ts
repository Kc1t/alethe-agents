import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve('hooks.json')),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

let aiMemoryEnabled = true
let voiceEnabled = false
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      preferences: {
        enabledFeatures: { aiMemory: aiMemoryEnabled },
        voiceConversationEnabled: voiceEnabled,
      },
    }),
  },
}))

import {
  agentHooksSettingsPath,
  agentPermissionDecide,
  agentVoiceHookedPtys,
  voiceSetTargets,
} from './agents'

describe('agentHooksSettingsPath', () => {
  beforeEach(() => {
    invoke.mockClear()
    aiMemoryEnabled = true
    voiceEnabled = false
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

  it('asks for the voice hooks when voice conversation is on', async () => {
    voiceEnabled = true
    await agentHooksSettingsPath('p', false)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ orchestrator: false, voice: true }),
    )
  })

  it('lets a caller opt out of the voice hooks', async () => {
    voiceEnabled = true
    await agentHooksSettingsPath('p', true, null, false)
    expect(invoke).toHaveBeenCalledWith(
      'agent_hooks_settings_path',
      expect.objectContaining({ voice: false }),
    )
  })
})

describe('permission commands', () => {
  beforeEach(() => invoke.mockClear())

  it('sends a deny with its reason', async () => {
    await agentPermissionDecide('req-1', 'deny', 'use pnpm')
    expect(invoke).toHaveBeenCalledWith('agent_permission_decide', {
      requestId: 'req-1',
      behavior: 'deny',
      message: 'use pnpm',
    })
  })

  it('sends no message for an allow', async () => {
    await agentPermissionDecide('req-1', 'allow')
    expect(invoke).toHaveBeenCalledWith('agent_permission_decide', {
      requestId: 'req-1',
      behavior: 'allow',
      message: null,
    })
  })

  it('replaces the voice targets', async () => {
    await voiceSetTargets(['pty-1'])
    expect(invoke).toHaveBeenCalledWith('voice_set_targets', { ptyIds: ['pty-1'] })
  })

  it('lists the PTYs launched with the voice hooks', async () => {
    invoke.mockResolvedValueOnce(['pty-1'] as never)
    await expect(agentVoiceHookedPtys()).resolves.toEqual(['pty-1'])
    expect(invoke).toHaveBeenCalledWith('agent_voice_hooked_ptys')
  })
})
