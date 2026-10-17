import { describe, expect, it } from 'vitest'

import { shouldSwitchToNative, sttChoiceFor } from './engine'

const choice = (provider: string, model: string, locale: string | null = null) =>
  ({ provider, model, locale }) as never

describe('sttChoiceFor', () => {
  it('returns the use own choice', () => {
    const prefs = {
      voiceStt: {
        dictation: choice('local', 'zipformer-small-en-int8'),
        conversation: choice('openai', 'whisper-1'),
      },
    }
    expect(sttChoiceFor(prefs, 'conversation')).toEqual({
      provider: 'openai',
      modelId: 'whisper-1',
      locale: null,
      needsLocale: false,
      fallbackLocale: null,
    })
  })

  it('asks for a locale when Apple has none', () => {
    const prefs = {
      voiceStt: {
        dictation: choice('apple', 'apple-speech'),
        conversation: choice('apple', 'apple-speech'),
      },
    }
    expect(sttChoiceFor(prefs, 'dictation').needsLocale).toBe(true)
  })

  it('offers an Apple locale from either use as the fallback', () => {
    const prefs = {
      voiceStt: {
        dictation: choice('openai', 'whisper-1'),
        conversation: choice('apple', 'apple-speech', 'pt-BR'),
      },
    }
    expect(sttChoiceFor(prefs, 'dictation').fallbackLocale).toBe('pt-BR')
  })
})

describe('shouldSwitchToNative', () => {
  const base = {
    migrated: false,
    modelId: 'parakeet-tdt-0.6b-v3-int8',
    nativeAvailable: true,
    parakeetReady: false,
  }

  it('switches an untouched default on a Mac with the native engine', () => {
    expect(shouldSwitchToNative(base)).toBe(true)
  })

  it('keeps a downloaded Parakeet', () => {
    expect(shouldSwitchToNative({ ...base, parakeetReady: true })).toBe(false)
  })

  it('keeps any other saved model', () => {
    expect(shouldSwitchToNative({ ...base, modelId: 'zipformer-small-en-int8' })).toBe(false)
  })

  it('runs once and only where the native engine exists', () => {
    expect(shouldSwitchToNative({ ...base, migrated: true })).toBe(false)
    expect(shouldSwitchToNative({ ...base, nativeAvailable: false })).toBe(false)
  })
})
