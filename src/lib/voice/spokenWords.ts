// Offsets are code points, as Rust counts them.
export type SpokenParts = { spoken: string; current: string; upcoming: string }

export const codePointLength = (text: string) => Array.from(text).length

const isSpace = (char: string) => /\s/.test(char)

// An offset on whitespace takes the next word; at or past the end, everything is spoken.
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

export function wordStartIn(chars: readonly string[], offset: number): number {
  let at = Math.max(0, Math.floor(offset))
  while (at < chars.length && isSpace(chars[at])) at += 1
  if (at >= chars.length) return chars.length
  while (at > 0 && !isSpace(chars[at - 1])) at -= 1
  return at
}
