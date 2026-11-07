import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setPluginEnabledMock = vi.fn(async () => {})
vi.mock('./host', () => ({
  setPluginEnabled: (id: string, enabled: boolean) => setPluginEnabledMock(id, enabled),
}))

const records: Record<string, Record<string, unknown>> = {}
vi.mock('./storage', () => ({
  createPluginStorage: (id: string) => ({
    read: async () => ({ ...(records[id] ?? {}) }),
    set: async (key: string, value: unknown) => {
      records[id] = { ...(records[id] ?? {}), [key]: value }
    },
  }),
}))

const keychain: { openrouter?: string } = {}
const setKeyMock = vi.fn(async (_provider: string, key: string) => {
  keychain.openrouter = key
})
vi.mock('../tauri/voiceProviders', () => ({
  voiceProviderKeyStatus: async () => keychain.openrouter !== undefined,
  voiceProviderSetKey: (provider: string, key: string) => setKeyMock(provider, key),
}))

let installed: { id: string; version: string }[] = []
vi.mock('../tauri/plugins', () => ({
  pluginsList: async () => installed,
}))

const {
  applyLegacyPluginMigrations,
  GIT_CONTROL_PLUGIN_ID,
  JEV_PLUGIN_ID,
  recordLegacyGitFlag,
  recordLegacyVoicePreferences,
} = await import('./legacyMigration')

beforeEach(() => setPluginEnabledMock.mockClear())
afterEach(async () => {
  // Drain anything a test recorded but did not apply.
  recordLegacyGitFlag(undefined)
  await applyLegacyPluginMigrations()
  setPluginEnabledMock.mockClear()
})

describe('legacy git feature migration', () => {
  it('disables the plugin when the old feature toggle was off', async () => {
    recordLegacyGitFlag(false)
    await applyLegacyPluginMigrations()
    expect(setPluginEnabledMock).toHaveBeenCalledWith(GIT_CONTROL_PLUGIN_ID, false)
  })

  it('leaves the plugin alone when the old toggle was on', async () => {
    recordLegacyGitFlag(true)
    await applyLegacyPluginMigrations()
    expect(setPluginEnabledMock).not.toHaveBeenCalled()
  })

  it('does nothing for a profile that never carried the flag', async () => {
    await applyLegacyPluginMigrations()
    expect(setPluginEnabledMock).not.toHaveBeenCalled()
  })

  it('runs only once per recorded flag', async () => {
    recordLegacyGitFlag(false)
    await applyLegacyPluginMigrations()
    await applyLegacyPluginMigrations()
    expect(setPluginEnabledMock).toHaveBeenCalledTimes(1)
  })

  it('ignores an undefined flag rather than clearing a recorded one', async () => {
    recordLegacyGitFlag(false)
    recordLegacyGitFlag(undefined)
    await applyLegacyPluginMigrations()
    expect(setPluginEnabledMock).toHaveBeenCalledWith(GIT_CONTROL_PLUGIN_ID, false)
  })
})

describe('legacy voice preferences', () => {
  beforeEach(() => {
    for (const id of Object.keys(records)) delete records[id]
  })

  it('hands the old voice preferences to the Jev plugin storage', async () => {
    recordLegacyVoicePreferences({
      uiTheme: 'dark',
      voiceCommandApiKey: 'sk-or-1',
      dictationEnabled: true,
    })
    await applyLegacyPluginMigrations()
    expect(records[JEV_PLUGIN_ID]).toEqual({
      legacyPreferences: { voiceCommandApiKey: 'sk-or-1', dictationEnabled: true },
    })
  })

  it('never overwrites settings the plugin already keeps', async () => {
    records[JEV_PLUGIN_ID] = { settings: { apiKey: 'current' } }
    recordLegacyVoicePreferences({ voiceCommandApiKey: 'old' })
    await applyLegacyPluginMigrations()
    expect(records[JEV_PLUGIN_ID]).toEqual({ settings: { apiKey: 'current' } })
  })

  it('writes nothing for a profile that never used voice', async () => {
    recordLegacyVoicePreferences({ uiTheme: 'dark' })
    await applyLegacyPluginMigrations()
    expect(records[JEV_PLUGIN_ID]).toBeUndefined()
  })
})

describe('Jev OpenRouter key', () => {
  beforeEach(() => {
    for (const id of Object.keys(records)) delete records[id]
    delete keychain.openrouter
    installed = []
    setKeyMock.mockClear()
  })

  it('copies the stored key into the keychain and leaves it for Jev 1.0', async () => {
    records[JEV_PLUGIN_ID] = { settings: { apiKey: ' sk-or-1 ', voiceEnabled: true } }
    installed = [{ id: JEV_PLUGIN_ID, version: '1.0.0' }]
    await applyLegacyPluginMigrations()
    expect(setKeyMock).toHaveBeenCalledWith('openrouter', 'sk-or-1')
    expect(records[JEV_PLUGIN_ID]).toEqual({
      settings: { apiKey: ' sk-or-1 ', voiceEnabled: true },
    })
  })

  it('never replaces a key the keychain already holds', async () => {
    keychain.openrouter = 'saved'
    records[JEV_PLUGIN_ID] = { settings: { apiKey: 'sk-or-1' } }
    await applyLegacyPluginMigrations()
    expect(setKeyMock).not.toHaveBeenCalled()
  })

  it('blanks the stored key once Jev reads the keychain', async () => {
    records[JEV_PLUGIN_ID] = {
      settings: { apiKey: 'sk-or-1', voiceEnabled: true },
      legacyPreferences: { voiceCommandApiKey: 'sk-or-0', dictationEnabled: true },
    }
    installed = [{ id: JEV_PLUGIN_ID, version: '1.1.0' }]
    await applyLegacyPluginMigrations()
    expect(keychain.openrouter).toBe('sk-or-1')
    expect(records[JEV_PLUGIN_ID]).toEqual({
      settings: { apiKey: '', voiceEnabled: true },
      legacyPreferences: { dictationEnabled: true },
    })
  })

  it('does nothing when Jev never had a key', async () => {
    records[JEV_PLUGIN_ID] = { settings: { apiKey: '' } }
    await applyLegacyPluginMigrations()
    expect(setKeyMock).not.toHaveBeenCalled()
  })
})
