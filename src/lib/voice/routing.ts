import type { VoiceMidTaskDefault } from '../types'

export type VoiceRoute =
  | { kind: 'empty' }
  | { kind: 'jev'; text: string }
  | { kind: 'send'; text: string; interrupt: boolean }

export type RoutingOptions = {
  jevTrigger: string
  interruptWords: string[]
  midTaskDefault: VoiceMidTaskDefault
  /** Claude is mid-turn on the target. */
  busy: boolean
  /** The Jev modifier was held with the shortcut. */
  jevModifier: boolean
}

/** Ways STT writes a trigger it has never heard as a word. Keyed by the normalized trigger. */
const TRIGGER_VARIANTS: Record<string, string[]> = {
  alethe: ['alethea', 'aletheia', 'aleth', 'alethi', 'aleti', 'alete', 'alethey', 'alethia'],
}

export function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

export function matchesTrigger(candidate: string, trigger: string): boolean {
  const wanted = normalizeWord(trigger)
  if (!wanted || !candidate) return false
  if (candidate === wanted) return true
  if ((TRIGGER_VARIANTS[wanted] ?? []).includes(candidate)) return true
  return wanted.length >= 4 && editDistance(candidate, wanted) <= 1
}

const LEADING_PUNCTUATION = /^[\s,.:;!?…-]+/u

/** The transcript after the trigger, or null when it does not start with the trigger. */
function afterTrigger(text: string, trigger: string): string | null {
  const tokens = text.split(/\s+/)
  if (matchesTrigger(normalizeWord(tokens[0] ?? ''), trigger)) {
    return tokens.slice(1).join(' ').replace(LEADING_PUNCTUATION, '')
  }
  // "A lethe" — STT sometimes splits the name in two.
  if (tokens.length >= 2 && matchesTrigger(normalizeWord(tokens[0] + tokens[1]), trigger)) {
    return tokens.slice(2).join(' ').replace(LEADING_PUNCTUATION, '')
  }
  return null
}

/**
 * The transcript after an interrupt word, or null. The word only counts on its own — followed by
 * punctuation or the end — so "stop words are…" is a sentence, not an interrupt.
 */
function afterInterrupt(text: string, words: string[]): string | null {
  const match = text.match(/^([\p{L}\p{N}'-]+)(?:[,.;:!?…]+|$)\s*(.*)$/su)
  if (!match) return null
  const wanted = new Set(words.map(normalizeWord).filter(Boolean))
  return wanted.has(normalizeWord(match[1])) ? match[2].trim() : null
}

export function routeTranscript(raw: string, options: RoutingOptions): VoiceRoute {
  const text = raw.trim()
  if (!text) return { kind: 'empty' }
  if (options.jevModifier) return { kind: 'jev', text }

  const jev = afterTrigger(text, options.jevTrigger)
  if (jev !== null) return { kind: 'jev', text: jev }

  const rest = afterInterrupt(text, options.interruptWords)
  if (rest !== null) return { kind: 'send', text: rest, interrupt: true }

  return {
    kind: 'send',
    text,
    interrupt: options.busy && options.midTaskDefault === 'interrupt',
  }
}
