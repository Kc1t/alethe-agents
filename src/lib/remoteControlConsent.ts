import type { TFunction } from './i18n'
import type { Preferences } from './types'

type RemoteConsentPreferences = Pick<
  Preferences,
  'remoteAllowShellInput' | 'remoteEnabled' | 'remoteReadOnly' | 'remoteSessionExpirySecs'
>

type Confirm = (message: string) => boolean

type SetPreferences = (patch: Partial<Preferences>) => void

function sessionExpiryLabel(t: TFunction, seconds: number): string {
  if (seconds === 900) return t('remote.session900')
  if (seconds === 3_600) return t('remote.session3600')
  if (seconds === 86_400) return t('remote.session86400')
  return t('remote.sessionSeconds', { seconds })
}

export function remoteControlEnableConfirmation(
  preferences: RemoteConsentPreferences,
  t: TFunction,
): string {
  const access = preferences.remoteReadOnly
    ? t('remote.confirmAccessReadOnly')
    : preferences.remoteAllowShellInput
      ? t('remote.confirmAccessShellInput')
      : t('remote.confirmAccessAgentInput')

  return t('remote.confirmEnable', {
    access,
    expiry: sessionExpiryLabel(t, preferences.remoteSessionExpirySecs),
  })
}

export function requestRemoteControlPreference(
  nextEnabled: boolean,
  preferences: RemoteConsentPreferences,
  setPreferences: SetPreferences,
  t: TFunction,
  confirm: Confirm = window.confirm,
): boolean {
  if (nextEnabled === preferences.remoteEnabled) return false
  if (nextEnabled && !confirm(remoteControlEnableConfirmation(preferences, t))) return false

  setPreferences({ remoteEnabled: nextEnabled })
  return true
}
