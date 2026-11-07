import { describe, expect, it } from 'vitest'

import {
  defaultVoice,
  describeVoice,
  isMultilingual,
  languageName,
  sortVoicesForLocale,
  voiceOption,
} from './voiceLanguages'

const t = (key: string) => key
const voices = (...ids: string[]) => ids.map((id) => ({ id, name: id, language: '' }))
const ids = (list: { id: string }[]) => list.map((voice) => voice.id)

describe('describeVoice', () => {
  it('reads Kokoro-style ids', () => {
    expect(describeVoice('pf_dora')).toEqual({ lang: 'pt-BR', gender: 'female', name: 'Dora' })
    expect(describeVoice('am_michael')).toEqual({ lang: 'en-US', gender: 'male', name: 'Michael' })
    expect(describeVoice('bf_emma').lang).toBe('en-GB')
    expect(describeVoice('zf_xiaobei').lang).toBe('zh-CN')
    expect(describeVoice('jm_kumo').lang).toBe('ja')
  })

  it('reads a BCP-47 prefix up to a colon', () => {
    expect(describeVoice('en-US-AriaNeural')).toEqual({ lang: 'en-US', name: 'AriaNeural' })
    expect(describeVoice('pt-BR_Francisca:v2')).toEqual({ lang: 'pt-BR', name: 'Francisca' })
  })

  it('canonicalizes explicit language tags', () => {
    expect(describeVoice('v', 'en-us').lang).toBe('en-US')
    expect(describeVoice('v', 'PT_br').lang).toBe('pt-BR')
    expect(describeVoice('v', 'not a tag!').lang).toBe('not a tag!')
  })

  it('uses an explicit language and normalizes underscores', () => {
    expect(describeVoice('21m00Tcm4', 'en')).toEqual({ lang: 'en', name: '21m00Tcm4' })
    expect(describeVoice('com.apple.luciana', 'pt_BR')).toEqual({
      lang: 'pt-BR',
      name: 'com.apple.luciana',
    })
  })

  it('treats anything else as multilingual', () => {
    expect(describeVoice('Zephyr')).toEqual({ lang: 'multi', name: 'Zephyr' })
    expect(describeVoice('alloy', '  ')).toEqual({ lang: 'multi', name: 'alloy' })
    expect(describeVoice('kf_x').lang).toBe('multi')
  })
})

describe('sortVoicesForLocale', () => {
  it('puts the app language first, then multilingual, then the rest by language', () => {
    const list = voices('Zephyr', 'af_bella', 'pf_dora', 'ef_dora', 'pm_alex', 'Puck')
    expect(ids(sortVoicesForLocale(list, 'pt-BR'))).toEqual([
      'pf_dora',
      'pm_alex',
      'Zephyr',
      'Puck',
      'af_bella',
      'ef_dora',
    ])
  })

  it('ranks the exact region before other regions of the same language', () => {
    const list = voices('Kore', 'bf_emma', 'af_bella')
    expect(ids(sortVoicesForLocale(list, 'en-US'))).toEqual(['af_bella', 'bf_emma', 'Kore'])
  })

  it('matches lower-case explicit tags to the app locale', () => {
    const list = [
      { id: 'a', name: 'A', language: 'fr-fr' },
      { id: 'b', name: 'B', language: 'en-us' },
    ]
    expect(defaultVoice(list, 'en-US')?.id).toBe('b')
  })

  it('does not mutate its input', () => {
    const list = voices('Kore', 'pf_dora')
    sortVoicesForLocale(list, 'pt-BR')
    expect(ids(list)).toEqual(['Kore', 'pf_dora'])
  })
})

describe('defaultVoice', () => {
  it('prefers the app language, then multilingual, then the first voice', () => {
    expect(defaultVoice(voices('Kore', 'af_bella', 'pf_dora'), 'pt-BR')?.id).toBe('pf_dora')
    expect(defaultVoice(voices('af_bella', 'Kore'), 'zh-CN')?.id).toBe('Kore')
    expect(defaultVoice(voices('af_bella', 'ef_dora'), 'zh-CN')?.id).toBe('af_bella')
    expect(defaultVoice([], 'en-US')).toBeNull()
  })

  it('reads explicit languages', () => {
    const list = [
      { id: 'a', name: 'Samantha', language: 'en-US' },
      { id: 'b', name: 'Luciana', language: 'pt-BR' },
    ]
    expect(defaultVoice(list, 'pt-BR')?.id).toBe('b')
  })
})

describe('voiceOption', () => {
  it('labels a voice name first, then gender and a short language', () => {
    const option = voiceOption({ id: 'pf_dora', name: 'pf_dora', language: '' }, 'en-US', t)
    expect(option.value).toBe('pf_dora')
    expect(option.label).toBe('Dora (prefs.voiceGenderFemale) · Portuguese (Brazil)')
    expect(option.searchText).toContain('pf_dora')
    expect(option.searchText).toContain('Dora')
    expect(option.searchText).toContain('Portuguese (Brazil)')
  })

  it('keeps the voice name when the id carries none', () => {
    const option = voiceOption({ id: 'x1', name: 'Luciana', language: 'pt-BR' }, 'en-US', t)
    expect(option.label).toBe('Luciana · Portuguese (Brazil)')
  })

  it('labels multilingual voices', () => {
    expect(voiceOption({ id: 'Zephyr', name: 'Zephyr' }, 'en-US', t).label).toBe(
      'Zephyr · prefs.voiceLangMulti',
    )
  })
})

describe('isMultilingual', () => {
  it('tells multilingual voices apart', () => {
    expect(isMultilingual({ id: 'Zephyr' })).toBe(true)
    expect(isMultilingual({ id: 'pf_dora' })).toBe(false)
    expect(isMultilingual({ id: 'x', language: 'en' })).toBe(false)
  })
})

describe('languageName', () => {
  it('falls back to the raw tag when Intl cannot name it', () => {
    expect(languageName('not a tag!', 'en-US')).toBe('not a tag!')
    expect(languageName('ja', 'not a locale!')).toBe('ja')
  })

  it('names a language in the display locale', () => {
    expect(languageName('pt-BR', 'en-US')).toBe('Portuguese (Brazil)')
    expect(languageName('en', 'pt-BR')).toBe('inglês')
  })
})
