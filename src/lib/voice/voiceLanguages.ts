import type { MessageKey } from '../i18n/messages/en'

export type VoiceGender = 'female' | 'male'
export type VoiceInfo = { lang: string | 'multi'; gender?: VoiceGender; name: string }
export type VoiceLike = { id: string; name?: string; language?: string }

const KOKORO_LANGS: Record<string, string> = {
  a: 'en-US',
  b: 'en-GB',
  e: 'es',
  f: 'fr',
  h: 'hi',
  i: 'it',
  j: 'ja',
  p: 'pt-BR',
  z: 'zh-CN',
}
const KOKORO = /^([abefhijpz])([fm])_(.+)$/
const BCP47_PREFIX = /^([a-z]{2}-[A-Z]{2})[-_:](.+)$/

export function describeVoice(id: string, language?: string): VoiceInfo {
  const kokoro = KOKORO.exec(id)
  if (kokoro) {
    const [, lang, gender, rest] = kokoro
    return {
      lang: KOKORO_LANGS[lang],
      gender: gender === 'f' ? 'female' : 'male',
      name: rest.charAt(0).toUpperCase() + rest.slice(1),
    }
  }
  const prefixed = BCP47_PREFIX.exec(id)
  if (prefixed) return { lang: prefixed[1], name: prefixed[2].split(':')[0] }
  const explicit = language?.trim().replace(/_/g, '-')
  if (explicit) return { lang: canonicalTag(explicit), name: id }
  return { lang: 'multi', name: id }
}

function canonicalTag(tag: string): string {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? tag
  } catch {
    return tag
  }
}

export function isMultilingual(voice: VoiceLike): boolean {
  return describeVoice(voice.id, voice.language).lang === 'multi'
}

function primary(tag: string): string {
  return tag.split('-')[0].toLowerCase()
}

function rank(lang: string, appLocale: string): number {
  if (lang === 'multi') return 2
  if (lang.toLowerCase() === appLocale.toLowerCase()) return 0
  if (primary(lang) === primary(appLocale)) return 1
  return 3
}

export function sortVoicesForLocale<V extends VoiceLike>(voices: V[], appLocale: string): V[] {
  const keyed = voices.map((voice, index) => {
    const { lang } = describeVoice(voice.id, voice.language)
    return { voice, index, lang, rank: rank(lang, appLocale) }
  })
  keyed.sort(
    (a, b) =>
      a.rank - b.rank || (a.rank === 3 ? a.lang.localeCompare(b.lang) : 0) || a.index - b.index,
  )
  return keyed.map((entry) => entry.voice)
}

export function defaultVoice<V extends VoiceLike>(voices: V[], appLocale: string): V | null {
  return sortVoicesForLocale(voices, appLocale)[0] ?? null
}

const displayNames = new Map<string, Intl.DisplayNames | null>()

function namesFor(displayLocale: string): Intl.DisplayNames | null {
  if (!displayNames.has(displayLocale)) {
    try {
      const names = new Intl.DisplayNames([displayLocale], {
        type: 'language',
        languageDisplay: 'standard',
      })
      displayNames.set(displayLocale, names)
    } catch {
      displayNames.set(displayLocale, null)
    }
  }
  return displayNames.get(displayLocale) ?? null
}

export function languageName(lang: string, displayLocale: string): string {
  try {
    return namesFor(displayLocale)?.of(lang) ?? lang
  } catch {
    return lang
  }
}

export function voiceDisplayName(voice: VoiceLike, t: (key: MessageKey) => string): string {
  const info = describeVoice(voice.id, voice.language)
  const name = info.name !== voice.id ? info.name : voice.name || voice.id
  const gender = info.gender
    ? ` (${t(info.gender === 'female' ? 'prefs.voiceGenderFemale' : 'prefs.voiceGenderMale')})`
    : ''
  return `${name}${gender}`
}

export function voiceOption(
  voice: VoiceLike,
  displayLocale: string,
  t: (key: MessageKey) => string,
): { value: string; label: string; searchText: string } {
  const info = describeVoice(voice.id, voice.language)
  const name = info.name !== voice.id ? info.name : voice.name || voice.id
  const language =
    info.lang === 'multi' ? t('prefs.voiceLangMulti') : languageName(info.lang, displayLocale)
  return {
    value: voice.id,
    label: `${voiceDisplayName(voice, t)} · ${language}`,
    searchText: `${voice.id} ${name} ${language} ${info.lang}`,
  }
}
