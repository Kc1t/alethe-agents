import type { MessageKey } from '../../../../lib/i18n/messages/en'
import type { Preferences } from '../../../../lib/types'
import { isCloudProvider } from '../../../../lib/voice/providers'
import type { VoiceTabUse } from './modelUses'
import { cloudStatus } from './providerMeta'
import type { RowStatus } from './useModelDownloads'

type VoicePrefs = Pick<Preferences, 'voiceStt' | 'voiceTts' | 'voiceProviders'>
/** What the warnings need from `useModelDownloads`. */
export type DownloadsView = { models: { id: string }[]; statusOf: (id: string) => RowStatus }
/** Apple's native status for a language (`ready`, `not-installed`, …); undefined until known. */
export type AppleStatusOf = (locale: string) => string | undefined

/** Why a local model cannot run yet, or null when it is downloaded. */
export function localModelWarning(status: RowStatus): MessageKey | null {
  switch (status.kind) {
    case 'ready':
      return null
    case 'downloading':
    case 'verifying':
    case 'unpacking':
      return 'prefs.voiceWarnDownloading'
    case 'paused':
      return 'prefs.voiceWarnPaused'
    default:
      return 'prefs.voiceWarnNotDownloaded'
  }
}

/** The same warning from a backend model state, for views without `useModelDownloads`. */
export function localStateWarning(status: string | undefined): MessageKey | null {
  if (status === 'ready') return null
  if (status === 'paused') return 'prefs.voiceWarnPaused'
  if (status === 'downloading') return 'prefs.voiceWarnDownloading'
  return 'prefs.voiceWarnNotDownloaded'
}

function providerWarning(
  provider: string,
  model: string,
  prefs: VoicePrefs,
  downloads: DownloadsView,
): MessageKey | null {
  if (provider === 'local') {
    // Before the model list loads every status reads "not downloaded"; stay quiet until then.
    if (downloads.models.length === 0) return null
    return localModelWarning(downloads.statusOf(model))
  }
  if (isCloudProvider(provider)) {
    const status = cloudStatus(prefs.voiceProviders[provider])
    if (status === 'invalid') return 'prefs.voiceStatusInvalid'
    if (status === 'disconnected') return 'prefs.voiceWarnNoKey'
  }
  return null
}

/** Why each voice use cannot work as configured, or null when it can. */
export function inUseWarnings(
  prefs: VoicePrefs,
  downloads: DownloadsView,
  appleStatusOf: AppleStatusOf = () => undefined,
  /** Saved local servers; null until the list loads. */
  servers: { id: string }[] | null = null,
): Record<VoiceTabUse, MessageKey | null> {
  const stt = (use: 'dictation' | 'conversation'): MessageKey | null => {
    const choice = prefs.voiceStt[use]
    if (choice.provider === 'apple') {
      if (!choice.locale) return 'prefs.dictationNativeNeedsLocale'
      return appleStatusOf(choice.locale) === 'not-installed'
        ? 'prefs.voiceWarnAppleNotInstalled'
        : null
    }
    return providerWarning(choice.provider, choice.model, prefs, downloads)
  }
  const narration = (): MessageKey | null => {
    const choice = prefs.voiceTts
    if (choice.provider === 'server') {
      if (servers === null) return null
      return servers.some((server) => server.id === choice.server)
        ? null
        : 'prefs.voiceServerRemoved'
    }
    return providerWarning(choice.provider, choice.model, prefs, downloads)
  }
  return {
    dictation: stt('dictation'),
    conversation: stt('conversation'),
    narration: narration(),
  }
}
