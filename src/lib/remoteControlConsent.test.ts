import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { type Locale, translate } from './i18n'
import { requestRemoteControlPreference } from './remoteControlConsent'

function preferences(overrides: Record<string, unknown> = {}) {
  return {
    remoteAllowShellInput: false,
    remoteEnabled: false,
    remoteReadOnly: true,
    remoteSessionExpirySecs: 3_600,
    ...overrides,
  }
}

function t(locale: Locale) {
  return (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(locale, key, params)
}

describe.each(['en', 'pt-BR'] as const)('remote control consent (%s)', (locale) => {
  it('confirms a false-to-true change with the configured exposure details', () => {
    const confirm = vi.fn(() => true)
    const setPreferences = vi.fn()

    expect(
      requestRemoteControlPreference(true, preferences(), setPreferences, t(locale), confirm),
    ).toBe(true)

    expect(confirm).toHaveBeenCalledOnce()
    const message = confirm.mock.calls[0][0]
    expect(message).toContain(locale === 'en' ? 'local network' : 'rede local')
    expect(message).toContain(locale === 'en' ? 'terminal output' : 'saída dos terminais')
    expect(message).toContain(locale === 'en' ? '1 hour' : '1 hora')
    expect(message).toContain(locale === 'en' ? 'read-only' : 'somente leitura')
    expect(message).toContain(locale === 'en' ? 'shell input' : 'entrada de shell')
    expect(setPreferences).toHaveBeenCalledWith({ remoteEnabled: true })
  })

  it('leaves the preference off when confirmation is cancelled', () => {
    const setPreferences = vi.fn()

    expect(
      requestRemoteControlPreference(
        true,
        preferences(),
        setPreferences,
        t(locale),
        vi.fn(() => false),
      ),
    ).toBe(false)
    expect(setPreferences).not.toHaveBeenCalled()
  })

  it('disables immediately without asking for confirmation', () => {
    const confirm = vi.fn()
    const setPreferences = vi.fn()

    expect(
      requestRemoteControlPreference(
        false,
        preferences({ remoteEnabled: true }),
        setPreferences,
        t(locale),
        confirm,
      ),
    ).toBe(true)

    expect(confirm).not.toHaveBeenCalled()
    expect(setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
  })
})

describe('remote control consent entry points', () => {
  it.each([
    ['quick modal', 'src/components/modals/RemoteControlModal.tsx'],
    ['preferences page', 'src/components/modals/preferences/RemoteControlPage.tsx'],
  ])('%s routes its enable control through the consent helper', (_, path) => {
    const source = readFileSync(resolve(path), 'utf8')

    expect(source).toMatch(/import \{ requestRemoteControlPreference \} from/)
    expect(source).toContain('requestRemoteControlPreference(')
  })
})
