import { SPEECH_MS_PER_CHAR } from './narrator'

/** The narration text around the word being spoken; offsets are code points, as Rust counts. */
export type SpokenParts = { spoken: string; current: string; upcoming: string }

export const codePointLength = (text: string) => Array.from(text).length

const isSpace = (char: string) => /\s/.test(char)

/**
 * Splits `text` at the word that contains `offset` (code points into it). Words are runs between
 * whitespace, so punctuation stays with its word; an offset on whitespace takes the next word,
 * and one at or past the end leaves everything spoken. Null when there is nothing to highlight.
 */
export function spokenParts(text: string, offset: number | null): SpokenParts | null {
  if (offset === null || !text) return null
  const chars = Array.from(text)
  const start = wordStartIn(chars, offset)
  if (start >= chars.length) return { spoken: text, current: '', upcoming: '' }
  let end = start
  while (end < chars.length && !isSpace(chars[end])) end += 1
  return {
    spoken: chars.slice(0, start).join(''),
    current: chars.slice(start, end).join(''),
    upcoming: chars.slice(end).join(''),
  }
}

/**
 * The start (in code points) of the word `offset` falls in, by the rules of `spokenParts`; the
 * length of the text when it is past the last word. Takes the text as code points, so a caller
 * asking many times splits it once.
 */
export function wordStartIn(chars: readonly string[], offset: number): number {
  let at = Math.max(0, Math.floor(offset))
  while (at < chars.length && isSpace(chars[at])) at += 1
  if (at >= chars.length) return chars.length
  while (at > 0 && !isSpace(chars[at - 1])) at -= 1
  return at
}

/**
 * Where an engine that reports no progress (the system voice) has got to: the narrator's pace of
 * `SPEECH_MS_PER_CHAR` a character, faster at a higher rate, clamped to the text.
 */
export function estimatedSpokenOffset(elapsedMs: number, rate: number, length: number): number {
  const reached = Math.floor((Math.max(0, elapsedMs) * Math.max(0.5, rate)) / SPEECH_MS_PER_CHAR)
  return Math.min(length, reached)
}
