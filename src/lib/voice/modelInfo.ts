import type { MessageKey } from '../i18n'
import type { HubModelInfo } from '../tauri'
import { hubModelInfo } from './hubModels'

export type Tier = 1 | 2 | 3
export type ModelUse = 'stt' | 'tts'

export interface ModelInfo {
  id: string
  use: ModelUse

  languages: string[]
  languageCount?: number
  speed?: Tier
  accuracy?: Tier

  recommended?: boolean
  summary: MessageKey
  details: MessageKey
  voice?: { gender: 'female' | 'male' }
  sourceUrl?: string

  estimated?: boolean
  voiceCount?: number

  multilingual?: boolean
}

type TFn = (key: MessageKey, params?: Record<string, string | number>) => string

export const MODEL_INFO: Record<string, ModelInfo> = {
  'parakeet-tdt-0.6b-v3-int8': {
    id: 'parakeet-tdt-0.6b-v3-int8',
    use: 'stt',
    languages: [
      'bg',
      'hr',
      'cs',
      'da',
      'nl',
      'en',
      'et',
      'fi',
      'fr',
      'de',
      'el',
      'hu',
      'it',
      'lv',
      'lt',
      'mt',
      'pl',
      'pt',
      'ro',
      'sk',
      'sl',
      'es',
      'sv',
      'ru',
      'uk',
    ],
    languageCount: 25,
    speed: 2,
    accuracy: 3,
    recommended: true,
    summary: 'voice.model.parakeet.summary',
    details: 'voice.model.parakeet.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  },
  'zipformer-gigaspeech-en-int8': {
    id: 'zipformer-gigaspeech-en-int8',
    use: 'stt',
    languages: ['en'],
    speed: 3,
    accuracy: 2,
    summary: 'voice.model.zipformerGiga.summary',
    details: 'voice.model.zipformerGiga.details',
  },
  'zipformer-small-en-int8': {
    id: 'zipformer-small-en-int8',
    use: 'stt',
    languages: ['en'],
    speed: 3,
    accuracy: 1,
    summary: 'voice.model.zipformerSmall.summary',
    details: 'voice.model.zipformerSmall.details',
  },
  'whisper-base-int8': {
    id: 'whisper-base-int8',
    use: 'stt',
    languages: [],
    languageCount: 99,
    speed: 3,
    accuracy: 1,
    summary: 'voice.model.whisperBase.summary',
    details: 'voice.model.whisperBase.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-base',
  },
  'whisper-small-int8': {
    id: 'whisper-small-int8',
    use: 'stt',
    languages: [],
    languageCount: 99,
    speed: 2,
    accuracy: 2,
    summary: 'voice.model.whisperSmall.summary',
    details: 'voice.model.whisperSmall.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small',
  },
  'moonshine-base-en-int8': {
    id: 'moonshine-base-en-int8',
    use: 'stt',
    languages: ['en'],
    speed: 3,
    accuracy: 2,
    summary: 'voice.model.moonshine.summary',
    details: 'voice.model.moonshine.details',
    sourceUrl: 'https://huggingface.co/csukuangfj/sherpa-onnx-moonshine-base-en-int8',
  },
  'piper-pt-br-faber-medium': {
    id: 'piper-pt-br-faber-medium',
    use: 'tts',
    languages: ['pt-BR'],
    speed: 3,
    accuracy: 2,
    voice: { gender: 'male' },
    summary: 'voice.model.piperFaber.summary',
    details: 'voice.model.piperFaber.details',
    sourceUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
  },
  'piper-en-us-amy-low': {
    id: 'piper-en-us-amy-low',
    use: 'tts',
    languages: ['en-US'],
    speed: 3,
    accuracy: 1,
    voice: { gender: 'female' },
    summary: 'voice.model.piperAmy.summary',
    details: 'voice.model.piperAmy.details',
    sourceUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
  },
}

const HUB_INFO = new Map<string, ModelInfo>()

export function rememberHubModels(
  models: { id: string; capability?: ModelUse; hub?: HubModelInfo | null }[],
): void {
  for (const model of models) {
    if (model.hub)
      HUB_INFO.set(model.id, hubModelInfo(model.id, model.capability ?? 'stt', model.hub))
  }
}

export function modelInfoFor(id: string): ModelInfo | null {
  return MODEL_INFO[id] ?? HUB_INFO.get(id) ?? null
}

export function languageName(tag: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], {
      type: 'language',
      languageDisplay: 'standard',
    }).of(tag)
    return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : tag
  } catch {
    return tag
  }
}

const LISTED_LANGUAGES = 3

const primary = (tag: string) => tag.split(/[-_]/)[0].toLowerCase()

function localeLanguage(info: ModelInfo, locale: string): string | undefined {
  return info.languages.find((tag) => primary(tag) === primary(locale))
}

export function isRecommended(info: ModelInfo | null, locale: string): boolean {
  if (!info) return false
  if (info.use === 'stt' || info.id.startsWith('hf:')) return info.recommended === true
  return localeLanguage(info, locale) !== undefined
}

export function languagesLabel(info: ModelInfo | null, t: TFn, locale: string): string {
  if (!info) return '—'
  const count = Math.max(info.languageCount ?? 0, info.languages.length)
  if (info.multilingual && info.languages.length === 0) return t('prefs.voiceModelLanguagesMulti')
  if (count > LISTED_LANGUAGES) {
    const own = localeLanguage(info, locale)
    return own
      ? t('prefs.voiceModelLanguagesManyWith', { count, language: languageName(own, locale) })
      : t('prefs.voiceModelLanguagesMany', { count })
  }
  return info.languages.map((tag) => languageName(tag, locale)).join(', ') || '—'
}

export function languagesList(info: ModelInfo | null, t: TFn, locale: string): string {
  if (info && info.languages.length > 0) {
    return info.languages.map((tag) => languageName(tag, locale)).join(', ')
  }
  return languagesLabel(info, t, locale)
}
