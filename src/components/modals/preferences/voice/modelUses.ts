import type { MessageKey } from '../../../../lib/i18n/messages/en'
import type { CloudVoiceProviderId, Preferences } from '../../../../lib/types'
import { DEFAULT_STT_CHOICE, DEFAULT_TTS_CHOICE } from '../../../../lib/voice/providers'
import type { VoiceTab } from './UsageTabs'

export type VoiceTabUse = VoiceTab

export const USE_LABEL: Record<VoiceTabUse, MessageKey> = {
  dictation: 'prefs.voiceTabDictation',
  conversation: 'prefs.voiceTabConversation',
  narration: 'prefs.voiceTabNarration',
}

/** The voice uses currently running this local model. */
export function usesOf(
  prefs: Pick<Preferences, 'voiceStt' | 'voiceTts'>,
  modelId: string,
): VoiceTabUse[] {
  const uses: VoiceTabUse[] = []
  for (const use of ['dictation', 'conversation'] as const) {
    const choice = prefs.voiceStt[use]
    if (choice.provider === 'local' && choice.model === modelId) uses.push(use)
  }
  if (prefs.voiceTts.provider === 'local' && prefs.voiceTts.model === modelId) {
    uses.push('narration')
  }
  return uses
}

/** The voice uses running this cloud provider; with `modelId`, only those running that model. */
export function cloudUsesOf(
  prefs: Pick<Preferences, 'voiceStt' | 'voiceTts'>,
  provider: CloudVoiceProviderId,
  modelId?: string,
): VoiceTabUse[] {
  const matches = (choice: { provider: string; model: string }) =>
    choice.provider === provider && (modelId === undefined || choice.model === modelId)
  const uses: VoiceTabUse[] = []
  for (const use of ['dictation', 'conversation'] as const) {
    if (matches(prefs.voiceStt[use])) uses.push(use)
  }
  if (matches(prefs.voiceTts)) uses.push('narration')
  return uses
}

/**
 * Moves every use of a removed local model to `fallback` (another downloaded model of the same
 * kind) or, without one, back to its default; the narration rate is kept.
 */
export function clearLocalModelUses(
  prefs: Pick<Preferences, 'voiceStt' | 'voiceTts'>,
  modelId: string,
  fallback: string | null = null,
): Pick<Preferences, 'voiceStt' | 'voiceTts'> {
  const uses = usesOf(prefs, modelId)
  const stt = fallback ? { provider: 'local' as const, model: fallback, locale: null } : null
  const sttFor = (use: 'dictation' | 'conversation') =>
    uses.includes(use) ? (stt ?? DEFAULT_STT_CHOICE) : prefs.voiceStt[use]
  return {
    voiceStt: { dictation: sttFor('dictation'), conversation: sttFor('conversation') },
    voiceTts: uses.includes('narration')
      ? fallback
        ? { provider: 'local', model: fallback, voice: null, rate: prefs.voiceTts.rate }
        : { ...DEFAULT_TTS_CHOICE, rate: prefs.voiceTts.rate }
      : prefs.voiceTts,
  }
}
