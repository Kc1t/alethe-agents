import type {
  CloudVoiceProviderId,
  Preferences,
  SttChoice,
  SttProviderId,
  TtsChoice,
  TtsProviderId,
  VoiceProviderFlags,
  VoiceUse,
} from '../types'
import {
  APPLE_MODEL_ID,
  CLOUD_VOICE_PROVIDERS,
  DEFAULT_STT_CHOICE,
  DEFAULT_TTS_CHOICE,
  isCloudProvider,
  STT_PROVIDERS,
  TTS_PROVIDERS,
} from './providers'

export type LegacyVoiceFields = {
  dictationModelId?: unknown
  dictationNativeLocale?: unknown
  voiceTtsVoice?: unknown
  voiceTtsRate?: unknown
  voiceStt?: unknown
  voiceTts?: unknown
  voiceProviders?: unknown
}

type VoicePreferences = Pick<Preferences, 'voiceStt' | 'voiceTts' | 'voiceProviders'>

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function clampRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(2, Math.max(0.5, value))
}

function normalizeProviderFlags(value: unknown): VoiceProviderFlags {
  const raw = record(value)
  const flags: VoiceProviderFlags = {}
  for (const id of CLOUD_VOICE_PROVIDERS) {
    const entry = raw[id]
    if (!entry || typeof entry !== 'object') continue
    const { configured, invalid } = entry as Record<string, unknown>
    if (typeof configured !== 'boolean') continue
    flags[id] = { configured, invalid: invalid === true }
  }
  return flags
}

function usable(provider: string, flags: VoiceProviderFlags): boolean {
  return !isCloudProvider(provider) || flags[provider]?.configured === true
}

function legacySttChoice(raw: LegacyVoiceFields): SttChoice {
  const model = text(raw.dictationModelId) ?? DEFAULT_STT_CHOICE.model
  if (model === APPLE_MODEL_ID) {
    return { provider: 'apple', model, locale: text(raw.dictationNativeLocale) }
  }
  return { provider: 'local', model, locale: null }
}

function normalizeSttChoice(
  value: unknown,
  fallback: SttChoice,
  flags: VoiceProviderFlags,
): SttChoice {
  if (!value || typeof value !== 'object') return fallback
  const { provider, model, locale } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(STT_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_STT_CHOICE
  }
  if (!usable(provider, flags)) return DEFAULT_STT_CHOICE
  if (provider === 'apple') return { provider, model: APPLE_MODEL_ID, locale: text(locale) }
  const id = text(model)
  return id ? { provider: provider as SttProviderId, model: id, locale: null } : DEFAULT_STT_CHOICE
}

function normalizeTtsChoice(
  value: unknown,
  fallback: TtsChoice,
  flags: VoiceProviderFlags,
): TtsChoice {
  if (!value || typeof value !== 'object') return fallback
  const { provider, model, voice, rate } = value as Record<string, unknown>
  if (typeof provider !== 'string' || !(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    return DEFAULT_TTS_CHOICE
  }
  if (!usable(provider, flags)) return DEFAULT_TTS_CHOICE
  const id = text(model) ?? ''
  if (provider !== 'system' && !id) return DEFAULT_TTS_CHOICE
  return {
    provider: provider as TtsProviderId,
    model: provider === 'system' ? '' : id,
    voice: text(voice),
    rate: clampRate(rate, DEFAULT_TTS_CHOICE.rate),
  }
}

/** Reads the current shape, or builds it from the pre-provider fields of an older profile. */
export function normalizeVoicePreferences(raw: LegacyVoiceFields | undefined): VoicePreferences {
  const source = raw ?? {}
  const voiceProviders = normalizeProviderFlags(source.voiceProviders)
  const legacyStt = legacySttChoice(source)
  const stt = record(source.voiceStt)
  const legacyTts: TtsChoice = {
    ...DEFAULT_TTS_CHOICE,
    voice: text(source.voiceTtsVoice),
    rate: clampRate(source.voiceTtsRate, DEFAULT_TTS_CHOICE.rate),
  }
  return {
    voiceStt: {
      dictation: normalizeSttChoice(stt.dictation, legacyStt, voiceProviders),
      conversation: normalizeSttChoice(stt.conversation, legacyStt, voiceProviders),
    },
    voiceTts: normalizeTtsChoice(source.voiceTts, legacyTts, voiceProviders),
    voiceProviders,
  }
}

export function withSttChoice(
  prefs: Pick<Preferences, 'voiceStt'>,
  use: VoiceUse,
  choice: SttChoice,
): Pick<Preferences, 'voiceStt'> {
  return { voiceStt: { ...prefs.voiceStt, [use]: choice } }
}

export function withTtsChoice(
  prefs: Pick<Preferences, 'voiceTts'>,
  patch: Partial<TtsChoice>,
): Pick<Preferences, 'voiceTts'> {
  return { voiceTts: { ...prefs.voiceTts, ...patch } }
}

export function clearProviderUses(
  prefs: Pick<Preferences, 'voiceStt' | 'voiceTts'>,
  provider: CloudVoiceProviderId,
): Pick<Preferences, 'voiceStt' | 'voiceTts'> {
  const stt = (choice: SttChoice) => (choice.provider === provider ? DEFAULT_STT_CHOICE : choice)
  return {
    voiceStt: {
      dictation: stt(prefs.voiceStt.dictation),
      conversation: stt(prefs.voiceStt.conversation),
    },
    voiceTts:
      prefs.voiceTts.provider === provider
        ? { ...DEFAULT_TTS_CHOICE, rate: prefs.voiceTts.rate }
        : prefs.voiceTts,
  }
}
