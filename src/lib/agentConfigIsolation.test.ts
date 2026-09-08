import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentLaunchEnv } from './agentConfigIsolation'
import * as misc from './api/misc'

afterEach(() => vi.restoreAllMocks())

describe('agentLaunchEnv', () => {
  it('points OpenCode at the configuration directory Alethe manages', () => {
    vi.spyOn(misc, 'agentConfigRoot').mockResolvedValue('C:/data/agent-config')
    return expect(agentLaunchEnv('opencode', { PATH: '/bin' })).resolves.toEqual({
      PATH: '/bin',
      XDG_CONFIG_HOME: 'C:/data/agent-config',
    })
  })

  it('adds the directory even when the caller passed no environment at all', async () => {
    // Two of the restart call sites passed none, so an agent restarted from them fell back to the
    // machine's global configuration with nothing to say so.
    vi.spyOn(misc, 'agentConfigRoot').mockResolvedValue('C:/data/agent-config')
    await expect(agentLaunchEnv('opencode')).resolves.toEqual({
      XDG_CONFIG_HOME: 'C:/data/agent-config',
    })
  })

  it('leaves other agents and the plain shell untouched', async () => {
    const root = vi.spyOn(misc, 'agentConfigRoot')
    await expect(agentLaunchEnv('claude', { PATH: '/bin' })).resolves.toEqual({ PATH: '/bin' })
    await expect(agentLaunchEnv('shell')).resolves.toBeUndefined()
    await expect(agentLaunchEnv(null)).resolves.toBeUndefined()
    expect(root).not.toHaveBeenCalled()
  })

  it('starts without isolation rather than refusing to start, and says so', async () => {
    // Falling back to the ambient configuration is the better failure, but it cannot be silent: the
    // agent then reads a different file from the one the MCP manager edits.
    vi.spyOn(misc, 'agentConfigRoot').mockRejectedValue(new Error('no data root'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(agentLaunchEnv('opencode', { PATH: '/bin' })).resolves.toEqual({ PATH: '/bin' })
    expect(logged).toHaveBeenCalled()
  })
})
