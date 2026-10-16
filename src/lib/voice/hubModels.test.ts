import { describe, expect, it } from 'vitest'

import type { HubModelInfo } from '../tauri'
import { hubErrorKey, hubModelInfo, hubSourceUrl } from './hubModels'
import { isRecommended, MODEL_INFO, modelInfoFor, rememberHubModels } from './modelInfo'

const hub = (extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo: 'csukuangfj/vits-piper-pt_BR-edresson-low',
  commit: null,
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: null,
  lastModified: null,
  likes: 0,
  fileCount: null,
  totalBytes: null,
  ...extra,
})

describe('hubModelInfo', () => {
  it('marks tiers as estimated and uses the family texts', () => {
    const info = hubModelInfo('hf:csukuangfj/vits-piper-pt_BR-edresson-low', 'tts', hub())
    expect(info).toMatchObject({
      use: 'tts',
      languages: ['pt-BR'],
      speed: 3,
      accuracy: 2,
      estimated: true,
      summary: 'voice.family.vits.summary',
      details: 'voice.family.vits.details',
      sourceUrl: 'https://huggingface.co/csukuangfj/vits-piper-pt_BR-edresson-low',
    })
  })

  it('curated overrides drop the estimate marker', () => {
    const info = hubModelInfo(
      'hf:csukuangfj/kokoro-multi-lang-v1_0',
      'tts',
      hub({ family: 'kokoro', repo: 'csukuangfj/kokoro-multi-lang-v1_0' }),
    )
    expect(info.estimated).toBe(false)
    expect(info.summary).toBe('voice.family.kokoro.summary')
  })

  it('recommends only curated hub models, whatever their language', () => {
    const piper = hubModelInfo('hf:csukuangfj/vits-piper-pt_BR-edresson-low', 'tts', hub())
    expect(piper.recommended).toBeUndefined()
    expect(isRecommended(piper, 'pt-BR')).toBe(false)
    const kokoro = hubModelInfo(
      'hf:csukuangfj/kokoro-multi-lang-v1_0',
      'tts',
      hub({ family: 'kokoro', repo: 'csukuangfj/kokoro-multi-lang-v1_0', languages: ['en-US'] }),
    )
    expect(isRecommended(kokoro, 'pt-BR')).toBe(true)
    const turbo = hubModelInfo(
      'hf:csukuangfj/sherpa-onnx-whisper-turbo',
      'stt',
      hub({ family: 'whisper', repo: 'csukuangfj/sherpa-onnx-whisper-turbo' }),
    )
    expect(isRecommended(turbo, 'en')).toBe(true)
    const sense = hubModelInfo(
      'hf:csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
      'stt',
      hub({ family: 'sense-voice' }),
    )
    expect(isRecommended(sense, 'en')).toBe(false)
    // The catalog keeps recommending by language.
    expect(isRecommended(MODEL_INFO['piper-pt-br-faber-medium'], 'pt-BR')).toBe(true)
  })

  it('ignores tiers outside 1–3', () => {
    const info = hubModelInfo('hf:x/y', 'stt', hub({ family: 'whisper', speed: null, accuracy: 7 }))
    expect(info.speed).toBeUndefined()
    expect(info.accuracy).toBeUndefined()
  })
})

describe('rememberHubModels', () => {
  it('lets modelInfoFor answer for hf ids', () => {
    expect(modelInfoFor('hf:csukuangfj/a')).toBeNull()
    rememberHubModels([
      {
        id: 'hf:csukuangfj/a',
        capability: 'stt',
        hub: hub({ family: 'whisper', repo: 'csukuangfj/a' }),
      },
    ])
    expect(modelInfoFor('hf:csukuangfj/a')?.summary).toBe('voice.family.whisper.summary')
    expect(modelInfoFor('parakeet-tdt-0.6b-v3-int8')?.estimated).toBeUndefined()
  })
})

describe('hubErrorKey', () => {
  it('search_error_kinds_map_to_messages', () => {
    expect(hubErrorKey('hub_offline')).toBe('prefs.voiceHubOffline')
    expect(hubErrorKey('hub_rate_limited')).toBe('prefs.voiceHubRateLimited')
    expect(hubErrorKey('hub_incompatible')).toBe('prefs.voiceHubIncompatible')
    expect(hubErrorKey('hub_too_large')).toBe('prefs.voiceHubTooLarge')
    expect(hubErrorKey('hub_unknown_repo')).toBe('prefs.voiceHubUnavailable')
    expect(hubErrorKey('hub_bad_response')).toBe('prefs.voiceHubFailed')
    expect(hubErrorKey('hub_unavailable')).toBe('prefs.voiceHubFailed')
    expect(hubErrorKey('something else')).toBeNull()
  })

  it('builds the repo page url', () => {
    expect(hubSourceUrl('k2-fsa/x')).toBe('https://huggingface.co/k2-fsa/x')
  })
})
