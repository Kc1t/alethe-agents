import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setPluginEnabledMock = vi.fn(async () => {})
vi.mock('./host', () => ({
  setPluginEnabled: (id: string, enabled: boolean) => setPluginEnabledMock(id, enabled),
}))

const { applyLegacyPluginMigrations, GIT_CONTROL_PLUGIN_ID, recordLegacyGitFlag } =
  await import('./legacyMigration')

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
