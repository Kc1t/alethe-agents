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
