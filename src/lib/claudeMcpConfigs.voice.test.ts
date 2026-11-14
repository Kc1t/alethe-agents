import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ hooks: vi.fn(async () => 'hooks.json') }))
vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => ({ projects: [], preferences: { enabledFeatures: {} } }) },
}))
vi.mock('./tauri', () => ({ agentHooksSettingsPath: mocks.hooks }))
vi.mock('./wsl', () => ({ wslTargetFor: () => null }))
import { claudeLaunchExtras } from './claudeMcpConfigs'
import { holdVoiceConversationHooks } from './voice/conversationHooks'
afterEach(() => {
  holdVoiceConversationHooks('launch-test', false)
  mocks.hooks.mockReset()
  mocks.hooks.mockResolvedValue('hooks.json')
})

describe('Claude voice hook launch settings', () => {
  it('passes the host conversation flag on initial launch and restart preparation', async () => {
    await claudeLaunchExtras({ ptyId: 'pty-1' })
    expect(mocks.hooks).toHaveBeenLastCalledWith('pty-1', undefined, undefined, false, false)
    holdVoiceConversationHooks('launch-test', true)
    await claudeLaunchExtras({ ptyId: 'pty-1' })
    expect(mocks.hooks).toHaveBeenLastCalledWith('pty-1', undefined, undefined, true, false)
    holdVoiceConversationHooks('launch-test', false)
    await claudeLaunchExtras({ ptyId: 'pty-1' })
    expect(mocks.hooks).toHaveBeenLastCalledWith('pty-1', undefined, undefined, false, false)
  })

  it('retains the existing launch behavior when hook settings generation fails', async () => {
    mocks.hooks.mockRejectedValueOnce(new Error('listener unavailable'))
    expect(await claudeLaunchExtras({ ptyId: 'pty-1' })).toMatchObject({
      hooksSettingsPath: undefined,
    })
  })
})
