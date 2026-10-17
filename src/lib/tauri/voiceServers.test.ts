import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { voiceServersDelete, voiceServersSave, voiceServersTest } from './voiceServers'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('voice server wrappers', () => {
  beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(undefined))

  it('saves with no key change by default and removes the key with an empty string', async () => {
    const input = {
      name: 'A',
      kind: 'openai' as const,
      baseUrl: 'http://localhost:4123',
      model: null,
    }
    await voiceServersSave(input)
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_save', { input, key: null })
    await voiceServersSave(input, '')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_save', { input, key: '' })
  })

  it('tests and deletes by id', async () => {
    await voiceServersTest('id1')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_test', { id: 'id1' })
    await voiceServersDelete('id1')
    expect(invoke).toHaveBeenLastCalledWith('voice_servers_delete', { id: 'id1' })
  })
})
