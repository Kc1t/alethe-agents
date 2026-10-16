import { describe, expect, it } from 'vitest'

import { DEFAULT_STT_CHOICE, DEFAULT_TTS_CHOICE } from './providers'
import {
  clearProviderUses,
  normalizeVoicePreferences,
  withSttChoice,
  withTtsChoice,
} from './voicePreferences'

describe('normalizeVoicePreferences', () => {
  it('gives local defaults to an empty profile', () => {
    expect(normalizeVoicePreferences(undefined)).toEqual({
      voiceStt: { dictation: DEFAULT_STT_CHOICE, conversation: DEFAULT_STT_CHOICE },
      voiceTts: DEFAULT_TTS_CHOICE,
      voiceProviders: {},
    })
  })

  it('moves a legacy Apple choice to both uses', () => {
    const result = normalizeVoicePreferences({
      dictationModelId: 'apple-speech',
      dictationNativeLocale: ' pt-BR ',
    })
    const apple = { provider: 'apple', model: 'apple-speech', locale: 'pt-BR' }
    expect(result.voiceStt).toEqual({ dictation: apple, conversation: apple })
  })

  it('moves a legacy sherpa model to both uses', () => {
    const result = normalizeVoicePreferences({ dictationModelId: 'zipformer-small-en-int8' })
    const local = { provider: 'local', model: 'zipformer-small-en-int8', locale: null }
    expect(result.voiceStt).toEqual({ dictation: local, conversation: local })
  })

  it('keeps the legacy system voice and clamps its rate', () => {
    const result = normalizeVoicePreferences({
      voiceTtsVoice: 'com.apple.voice.Luciana',
      voiceTtsRate: 9,
    })
    expect(result.voiceTts).toEqual({
      provider: 'system',
      model: '',
      voice: 'com.apple.voice.Luciana',
      rate: 2,
      server: null,
    })
  })

  it('prefers the new shape over legacy fields', () => {
    const result = normalizeVoicePreferences({
      dictationModelId: 'apple-speech',
      voiceProviders: { openai: { configured: true, invalid: false } },
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: 'x' },
        conversation: { provider: 'local', model: 'parakeet-tdt-0.6b-v3-int8', locale: null },
      },
    })
    expect(result.voiceStt.dictation).toEqual({
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      locale: null,
    })
    expect(result.voiceStt.conversation.provider).toBe('local')
  })

  it('resets an unknown or unconfigured cloud provider to the local default', () => {
    const result = normalizeVoicePreferences({
      voiceStt: {
        dictation: { provider: 'openai', model: 'gpt-4o-transcribe', locale: null },
        conversation: { provider: 'mystery', model: 'x', locale: null },
      },
      voiceTts: { provider: 'elevenlabs', model: 'eleven_flash_v2_5', voice: 'abc', rate: 1 },
    })
    expect(result.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(result.voiceStt.conversation).toEqual(DEFAULT_STT_CHOICE)
    expect(result.voiceTts).toEqual(DEFAULT_TTS_CHOICE)
  })

  it('drops malformed provider flags', () => {
    const result = normalizeVoicePreferences({
      voiceProviders: { openai: { configured: true }, gemini: 'yes', bogus: { configured: true } },
    })
    expect(result.voiceProviders).toEqual({ openai: { configured: true, invalid: false } })
  })
})

describe('choice helpers', () => {
  const prefs = normalizeVoicePreferences(undefined)

  it('replaces one use only', () => {
    const next = withSttChoice(prefs, 'conversation', {
      provider: 'apple',
      model: 'apple-speech',
      locale: 'en-US',
    })
    expect(next.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(next.voiceStt.conversation.provider).toBe('apple')
  })

  it('patches the narration choice', () => {
    expect(withTtsChoice(prefs, { rate: 1.5 }).voiceTts).toEqual({
      ...DEFAULT_TTS_CHOICE,
      rate: 1.5,
    })
  })
})

describe('provider flags', () => {
  it('moves every use off a provider whose key is gone', () => {
    const prefs = {
      voiceStt: {
        dictation: { provider: 'openai' as const, model: 'whisper-1', locale: null },
        conversation: { provider: 'apple' as const, model: 'apple-speech', locale: 'pt-BR' },
      },
      voiceTts: { provider: 'openai' as const, model: 'gpt-4o-mini-tts', voice: 'nova', rate: 1.5 },
    }
    const next = clearProviderUses(prefs, 'openai')
    expect(next.voiceStt.dictation).toEqual(DEFAULT_STT_CHOICE)
    expect(next.voiceStt.conversation).toEqual(prefs.voiceStt.conversation)
    expect(next.voiceTts).toEqual({ ...DEFAULT_TTS_CHOICE, rate: 1.5 })
  })
})

describe('server narration choice', () => {
  it('keeps a server choice with its server id', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: {
        provider: 'server',
        model: 'x',
        voice: 'pt-ref',
        rate: 1.25,
        server: 'V1StGXR8_Z5jdHi6B-myT',
      },
    })
    expect(prefs.voiceTts).toEqual({
      provider: 'server',
      model: '',
      voice: 'pt-ref',
      rate: 1.25,
      server: 'V1StGXR8_Z5jdHi6B-myT',
    })
  })

  it('drops a server choice without a server id to the default', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: { provider: 'server', model: '', voice: null, rate: 1 },
    })
    expect(prefs.voiceTts.provider).toBe('system')
    expect(prefs.voiceTts.server ?? null).toBeNull()
  })

  it('clears a stray server id on other providers', () => {
    const prefs = normalizeVoicePreferences({
      voiceTts: {
        provider: 'system',
        model: '',
        voice: null,
        rate: 1,
        server: 'V1StGXR8_Z5jdHi6B-myT',
      },
    })
    expect(prefs.voiceTts.server).toBeNull()
  })
})
