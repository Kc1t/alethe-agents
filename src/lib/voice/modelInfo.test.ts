import { describe, expect, it } from 'vitest'

import { isRecommended, languagesLabel, languagesList, MODEL_INFO, modelInfoFor } from './modelInfo'

const BUILT_IN = [
  'parakeet-tdt-0.6b-v3-int8',
  'zipformer-gigaspeech-en-int8',
  'zipformer-small-en-int8',
  'whisper-base-int8',
  'whisper-small-int8',
  'moonshine-base-en-int8',
  'piper-pt-br-faber-medium',
  'piper-en-us-amy-low',
]
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe('modelInfo', () => {
  it('covers every built-in catalog id', () => {
    for (const id of BUILT_IN) expect(MODEL_INFO[id], id).toBeDefined()
  })

  it('recommends exactly one speech-to-text model whatever the locale', () => {
    for (const locale of ['en', 'pt-BR', 'zh-CN']) {
      const stt = Object.values(MODEL_INFO).filter(
        (info) => info.use === 'stt' && isRecommended(info, locale),
      )
      expect(stt.map((info) => info.id)).toEqual(['parakeet-tdt-0.6b-v3-int8'])
    }
  })

  it('recommends the voice that speaks the app language, else none', () => {
    const tts = (locale: string) =>
      Object.values(MODEL_INFO)
        .filter((info) => info.use === 'tts' && isRecommended(info, locale))
        .map((info) => info.id)
    expect(tts('pt-BR')).toEqual(['piper-pt-br-faber-medium'])
    expect(tts('en')).toEqual(['piper-en-us-amy-low'])
    expect(tts('zh-CN')).toEqual([])
  })

  it('returns null for unknown ids', () => {
    expect(modelInfoFor('someone/new-model')).toBeNull()
  })

  it('labels languages', () => {
    expect(languagesLabel(MODEL_INFO['zipformer-small-en-int8'], t, 'en')).toBe('English')
    expect(languagesLabel(MODEL_INFO['piper-pt-br-faber-medium'], t, 'en')).toBe(
      'Portuguese (Brazil)',
    )
    expect(languagesLabel(MODEL_INFO['whisper-base-int8'], t, 'en')).toBe(
      'prefs.voiceModelLanguagesMany:{"count":99}',
    )
    expect(languagesLabel(MODEL_INFO['whisper-small-int8'], t, 'pt-BR')).toBe(
      'prefs.voiceModelLanguagesMany:{"count":99}',
    )
    expect(languagesLabel(null, t, 'en')).toBe('—')
  })

  it('names the app language in a long list only when the model covers it', () => {
    const parakeet = MODEL_INFO['parakeet-tdt-0.6b-v3-int8']
    expect(parakeet.languages).toHaveLength(25)
    expect(parakeet.languageCount).toBe(25)
    expect(languagesLabel(parakeet, t, 'pt-BR')).toBe(
      'prefs.voiceModelLanguagesManyWith:{"count":25,"language":"Português"}',
    )
    expect(languagesLabel(parakeet, t, 'en')).toBe(
      'prefs.voiceModelLanguagesManyWith:{"count":25,"language":"English"}',
    )
    expect(languagesLabel(parakeet, t, 'zh-CN')).toBe('prefs.voiceModelLanguagesMany:{"count":25}')
  })

  it('lists every language a model names, localized', () => {
    const list = languagesList(MODEL_INFO['parakeet-tdt-0.6b-v3-int8'], t, 'en')
    expect(list.split(', ')).toHaveLength(25)
    expect(list).toContain('Bulgarian')
    expect(list).toContain('Ukrainian')
    expect(languagesList(MODEL_INFO['whisper-base-int8'], t, 'en')).toBe(
      'prefs.voiceModelLanguagesMany:{"count":99}',
    )
    expect(languagesList(null, t, 'en')).toBe('—')
  })
})
