import { beforeEach, describe, expect, it, vi } from 'vitest'

const voiceProviderSetKey = vi.hoisted(() => vi.fn())

vi.mock('../tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tauri')>()),
  saveProjectsFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../tauri/voiceProviders', () => ({ voiceProviderSetKey }))

import { useProjectsStore } from '../../stores/projectsStore'
import { EMPTY_PROJECTS_FILE } from '../types'
import { migrateLegacyJevKey, saveJevKey } from './jevKey'

const prefs = () => useProjectsStore.getState().preferences

function setLegacyKey(key: string, openrouterConfigured = false) {
  useProjectsStore.getState().setPreferences({
    voiceCommandApiKey: key,
    voiceProviders: openrouterConfigured
      ? { openrouter: { configured: true, invalid: false } }
      : {},
  })
}

describe('Jev key', () => {
  beforeEach(() => {
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
    voiceProviderSetKey.mockReset()
    voiceProviderSetKey.mockResolvedValue(undefined)
  })

  it('saves a key typed in the bar to the keychain as the OpenRouter key', async () => {
    await saveJevKey('  sk-or-1  ')
    expect(voiceProviderSetKey).toHaveBeenCalledWith('openrouter', 'sk-or-1')
    expect(prefs().voiceProviders.openrouter).toEqual({ configured: true, invalid: false })
  })

  it('moves a plaintext key into the keychain and clears it', async () => {
    setLegacyKey('sk-or-legacy')
    await migrateLegacyJevKey()
    expect(voiceProviderSetKey).toHaveBeenCalledWith('openrouter', 'sk-or-legacy')
    expect(prefs().voiceCommandApiKey).toBe('')
    expect(prefs().voiceProviders.openrouter?.configured).toBe(true)
  })

  it('keeps the keychain key when one is already saved', async () => {
    setLegacyKey('sk-or-legacy', true)
    await migrateLegacyJevKey()
    expect(voiceProviderSetKey).not.toHaveBeenCalled()
    expect(prefs().voiceCommandApiKey).toBe('')
  })

  it('keeps the plaintext key for the next start when the keychain fails', async () => {
    setLegacyKey('sk-or-legacy')
    voiceProviderSetKey.mockRejectedValue('keychain locked')
    await migrateLegacyJevKey()
    expect(prefs().voiceCommandApiKey).toBe('sk-or-legacy')
  })

  it('drops a plaintext key the keychain refuses as malformed', async () => {
    setLegacyKey('bad')
    voiceProviderSetKey.mockRejectedValue('voice_key_invalid_format')
    await migrateLegacyJevKey()
    expect(prefs().voiceCommandApiKey).toBe('')
    expect(prefs().voiceProviders.openrouter?.configured).not.toBe(true)
  })

  it('does nothing without a plaintext key', async () => {
    await migrateLegacyJevKey()
    expect(voiceProviderSetKey).not.toHaveBeenCalled()
  })
})
