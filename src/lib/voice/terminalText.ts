/**
 * Terminal text made fit to hear: what a person selected in a pane, and the reply of a harness
 * that has no transcript Alethe can read (its screen is all there is).
 */

/** Box drawing, block elements, braille spinners and the bullets agent TUIs draw. */
const TUI_GLYPHS = /[─-▟⠀-⣿⏺●○◉◯✻✶✳✢✽⎿⏵⏴▶►◆◇■□▪▫•]/g
/** The input marker a TUI draws in front of the prompt line. */
const PROMPT_MARKER = /^\s*[>❯›$]\s+/
/** Key hints, token and context meters: chrome around the reply, never part of it. */
const CHROME_LINES = [
  /\b(?:esc|ctrl|shift|alt|tab|enter)\s*(?:\+\s*\w|to\s)/i,
  /\?\s*for shortcuts/i,
  /\b\d+(?:[.,]\d+)?\s*k?\s*tokens?\b/i,
  /\bcontext\b.*\d+\s*%|\d+\s*%\s*(?:context|left|used)/i,
  // A status bar with a duration: "Build · Big Pickle · 37.6s", "Working (12s | esc)".
  /[·•|].*\b\d+(?:\.\d+)?\s?(?:ms|s)\b|\b\d+(?:\.\d+)?\s?(?:ms|s)\b.*[·•|]/,
  // How long it thought: "Thought: 6.3s", "Thought: 814ms".
  /^\W*(?:thought|thinking|reasoning)\b[^.!?]*\d+(?:\.\d+)?\s?m?s$/i,
]
/**
 * Blank rows in a row that end the reply: a full-screen TUI leaves its empty transcript area
 * between the last line said and the input box and footer at the bottom.
 */
const FOOTER_GAP_LINES = 4
/** Fewer letters than this and a line is a frame, a spinner or a stray symbol. */
const MIN_LETTERS = 2
/** The screen reply is cut to its last part: a long one is better read in the terminal. */
export const MAX_REPLY_CHARS = 1500
/** Utterances are kept short, so a pause or a stop never waits long and cloud limits are met. */
export const SPEECH_CHUNK_CHARS = 400

const SENTENCE = /[^.!?…。！？]+(?:[.!?…]+(?=\s|$)|[。！？]+|$)/g

/** One rendered line without TUI glyphs, prompt marker or runs of spaces. */
export function cleanTerminalLine(line: string): string {
  return line.replace(TUI_GLYPHS, ' ').replace(PROMPT_MARKER, '').replace(/\s+/g, ' ').trim()
}

const letters = (line: string) => (line.match(/\p{L}/gu) ?? []).length
const isChrome = (line: string) =>
  letters(line) < MIN_LETTERS || CHROME_LINES.some((pattern) => pattern.test(line))
const normalize = (text: string) => cleanTerminalLine(text).toLowerCase()

/**
 * Selected terminal text as prose: glyphs dropped, lines of a paragraph joined (a terminal wraps
 * at its width, not at sentence ends), paragraphs kept apart by a newline.
 */
export function readableTerminalText(raw: string): string {
  const paragraphs: string[] = []
  let current: string[] = []
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const clean = cleanTerminalLine(line)
    if (clean && letters(clean) > 0) {
      current.push(clean)
      continue
    }
    if (current.length > 0) paragraphs.push(current.join(' '))
    current = []
  }
  if (current.length > 0) paragraphs.push(current.join(' '))
  return paragraphs.join('\n')
}

/**
 * Where the reply starts: past the new echo of `prompt` (its first line not already on screen
 * before, through the line that ends the prompt when it wraps), or 0 when there is no echo. The
 * first echo, not the last: a reply may well repeat the prompt's words.
 */
function afterEcho(lines: string[], prompt: string, seen: Set<string>): number {
  const key = normalize(prompt)
  // Short enough to sit on one row of the echo even when the prompt wraps.
  const head = key.slice(0, 30)
  const tail = key.slice(-16)
  if (head.length < 4) return 0
  const echo = lines.findIndex((line) => {
    const text = normalize(line)
    return text.includes(head) && !seen.has(text)
  })
  if (echo < 0) return 0
  // A wrapped prompt runs over about one line per 20 characters at the narrowest panes.
  const span = Math.ceil(key.length / 20) + 2
  for (let index = echo; index < Math.min(lines.length, echo + span); index++) {
    if (normalize(lines[index]).includes(tail)) return index + 1
  }
  return echo + 1
}

/**
 * What the agent printed for `prompt`: the lines of `after` that follow the prompt's echo and
 * were not on `before`, chrome left out, up to the empty rows a full-screen TUI leaves above its
 * input box. A long reply keeps its end, from a sentence start.
 */
export function screenReply(before: string, after: string, prompt: string): string {
  const seen = new Set(before.split('\n').map(normalize).filter(Boolean))
  const lines = after.split('\n')
  const kept: string[] = []
  let blankRun = 0
  for (const raw of lines.slice(afterEcho(lines, prompt, seen))) {
    const line = cleanTerminalLine(raw)
    if (!line) {
      blankRun += 1
      if (kept.length > 0 && blankRun >= FOOTER_GAP_LINES) break
      continue
    }
    blankRun = 0
    if (!seen.has(line.toLowerCase()) && !isChrome(line)) kept.push(line)
  }
  const reply = kept.join('\n')
  if (reply.length <= MAX_REPLY_CHARS) return reply
  const tail = reply.slice(-MAX_REPLY_CHARS)
  const sentence = tail.search(/[.!?…。！？]\s+\S/)
  return (sentence >= 0 ? tail.slice(sentence + 1) : tail).trim()
}

/** `text` cut at sentence ends into parts of at most `max` characters (a longer sentence at spaces). */
export function chunkForSpeech(text: string, max = SPEECH_CHUNK_CHARS): string[] {
  const parts: string[] = []
  let current = ''
  const push = (piece: string) => {
    const trimmed = piece.trim()
    if (!trimmed) return
    if (current && current.length + 1 + trimmed.length > max) {
      parts.push(current)
      current = ''
    }
    current = current ? `${current} ${trimmed}` : trimmed
  }
  for (const paragraph of text.split('\n')) {
    for (const sentence of paragraph.match(SENTENCE) ?? []) {
      if (sentence.trim().length <= max) {
        push(sentence)
        continue
      }
      for (const word of sentence.split(/\s+/)) push(word)
    }
  }
  if (current) parts.push(current)
  return parts
}
