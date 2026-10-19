import type { Preferences, SttProviderId, VoiceUse } from '../types'
import { APPLE_MODEL_ID, PARAKEET_MODEL_ID } from '../voice/providers'

export { PARAKEET_MODEL_ID }

export type SttEngineArgs = {
  provider: SttProviderId
  modelId: string
  locale: string | null
  needsLocale: boolean
  /** An Apple locale set on any use, so a failed cloud call can fall back to Apple Speech. */
  fallbackLocale: string | null
}

/** What every speech consumer passes to the speech commands for one use. */
export function sttChoiceFor(prefs: Pick<Preferences, 'voiceStt'>, use: VoiceUse): SttEngineArgs {
  const choice = prefs.voiceStt[use]
  const fallbackLocale =
    [choice, prefs.voiceStt.dictation, prefs.voiceStt.conversation].find(
      (candidate) => candidate.provider === 'apple' && candidate.locale,
    )?.locale ?? null
  if (choice.provider !== 'apple') {
    return {
      provider: choice.provider,
      modelId: choice.model,
      locale: null,
      needsLocale: false,
      fallbackLocale,
    }
  }
  return {
    provider: 'apple',
    modelId: APPLE_MODEL_ID,
    locale: choice.locale,
    needsLocale: choice.locale === null,
    fallbackLocale,
  }
}

/** Spec §5.3: move an untouched default to the Apple engine once, never a real choice. */
export function shouldSwitchToNative(input: {
  migrated: boolean
  modelId: string
  nativeAvailable: boolean
  parakeetReady: boolean
}): boolean {
  return (
    !input.migrated &&
    input.nativeAvailable &&
    input.modelId === PARAKEET_MODEL_ID &&
    !input.parakeetReady
  )
}
