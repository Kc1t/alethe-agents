import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ voiceServersList: vi.fn() }))
vi.mock('../lib/tauri', () => tauri)

import { useVoiceServersStore } from './voiceServersStore'

const server = {
  id: 'V1StGXR8_Z5jdHi6B-myT',
  name: 'Chatterbox',
  kind: 'openai' as const,
  baseUrl: 'http://localhost:4123',
  model: null,
  hasKey: false,
}

describe('voiceServersStore', () => {
  beforeEach(() => {
    useVoiceServersStore.setState({ servers: [], loaded: false, failed: false, health: {} })
    tauri.voiceServersList.mockReset()
  })

  it('loads the list and keeps health for servers that still exist', async () => {
    useVoiceServersStore.setState({ health: { [server.id]: 'connected', gone: 'invalid' } })
    tauri.voiceServersList.mockResolvedValue([server])
    await useVoiceServersStore.getState().refresh()
    const state = useVoiceServersStore.getState()
    expect(state.servers).toEqual([server])
    expect(state.loaded).toBe(true)
    expect(state.failed).toBe(false)
    expect(state.health).toEqual({ [server.id]: 'connected' })
  })

  it('marks the list loaded even when listing fails', async () => {
    tauri.voiceServersList.mockRejectedValue(new Error('x'))
    await useVoiceServersStore.getState().refresh()
    expect(useVoiceServersStore.getState()).toMatchObject({
      servers: [],
      loaded: true,
      failed: true,
    })
  })
})
