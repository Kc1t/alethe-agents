import type { TFunction } from './i18n'
import type { Preferences } from './types'

type RemoteConsentPreferences = Pick<
  Preferences,
  | 'remoteAllowShellInput'
  | 'remoteEnabled'
  | 'remoteReadOnly'
  | 'remoteSessionExpirySecs'
  | 'remoteUseTailscale'
>

type Confirm = (message: string) => boolean

type SetPreferences = (patch: Partial<Preferences>) => void

function sessionExpiryLabel(t: TFunction, seconds: number): string {
  if (seconds === 900) return t('remote.session900')
  if (seconds === 3_600) return t('remote.session3600')
  if (seconds === 86_400) return t('remote.session86400')
  if (seconds === 315_360_000) return t('remote.sessionPermanent')
  return t('remote.sessionSeconds', { seconds })
}

/** Spells out what turning Remote Control on exposes under the current policy. */
export function remoteControlEnableConfirmation(
  preferences: RemoteConsentPreferences,
  t: TFunction,
): string {
  const access = preferences.remoteReadOnly
    ? t('remote.confirmAccessReadOnly')
    : preferences.remoteAllowShellInput
      ? t('remote.confirmAccessShellInput')
      : t('remote.confirmAccessAgentInput')

  return t(
    preferences.remoteUseTailscale ? 'remote.confirmEnableTailscale' : 'remote.confirmEnable',
    {
      access,
      expiry: sessionExpiryLabel(t, preferences.remoteSessionExpirySecs),
    },
  )
}

/**
 * The single path every Remote Control on/off control goes through: enabling
 * requires informed consent, disabling never asks. Returns whether the
 * preference changed.
 */
export function requestRemoteControlPreference(
  nextEnabled: boolean,
  preferences: RemoteConsentPreferences,
  setPreferences: SetPreferences,
  t: TFunction,
  confirm: Confirm = (message) => window.confirm(message),
): boolean {
  if (nextEnabled === preferences.remoteEnabled) return false
  if (nextEnabled && !confirm(remoteControlEnableConfirmation(preferences, t))) return false

  setPreferences({ remoteEnabled: nextEnabled })
  return true
}
