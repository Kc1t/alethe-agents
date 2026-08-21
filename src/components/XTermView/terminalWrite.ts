import { readScopedStorage } from '../../lib/storageNamespace'
import { writePty } from '../../lib/tauri'

export const PROMPT_HISTORY_KEY = (id: string) => `prompt-history:${id}`

// Keep IPC payloads bounded without turning a large paste into thousands of calls.
export const PASTE_CHUNK_SIZE = 64 * 1024
export const PASTE_YIELD_EVERY_CHUNKS = 4
export const MAX_TRACKED_PROMPT_LENGTH = 4 * 1024
export const PTY_WRITE_TIMEOUT_MS = 5_000

// muita cor/movimento) custam bem mais tempo de parse+render por byte do que

// terminar > qualquer frame individual travando por muito tempo.
export const TERMINAL_WRITE_FRAME_BUDGET = 16 * 1024

/**
 * A PTY can hand over 64 KB every 16 ms while a frame drains 16 KB, so a command that prints fast
 * outruns the terminal four to one. Left unbounded the queue keeps growing, the pane renders output
 * from minutes ago, and the frame it asks for every 16 ms never stops arriving — which stalls every
 * other pane, since they all draw on the same thread.
 */
export const MAX_PENDING_WRITE_BYTES = 512 * 1024

/**
 * Drops the oldest queued output so the terminal shows what is happening now instead of replaying a
 * backlog. Whole chunks go at a time: slicing one in half would cut an escape sequence.
 */
export function trimPendingWrites(
  pending: string[],
  length: number,
  cap = MAX_PENDING_WRITE_BYTES,
): { length: number; dropped: number } {
  let dropped = 0
  while (length > cap && pending.length > 1) {
    const head = pending.shift()
    if (head === undefined) break
    length -= head.length
    dropped += head.length
  }
  return { length, dropped }
}

export function loadPromptHistory(ptyId: string): string[] {
  const raw = readScopedStorage(PROMPT_HISTORY_KEY(ptyId), true)
  if (!raw) return []
  const history = JSON.parse(raw) as string[]
  return history
}

export type PromptHistoryInputState = {
  currentLine: string
  overflow: boolean
  history: string[]
}

/** Prevents one blocked ConPTY write from holding every subsequent keystroke forever. */
export async function writePtyWithTimeout(id: string, data: string): Promise<void> {
  let timeoutId: number | null = null
  try {
    await Promise.race([
      writePty(id, data),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`PTY write timed out after ${PTY_WRITE_TIMEOUT_MS} ms`))
        }, PTY_WRITE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  }
}

/** Updates lightweight command history without retaining or scanning large pasted documents. */
export function applyPromptHistoryInput(
  state: PromptHistoryInputState,
  data: string,
  onSubmit?: (line: string) => void,
): boolean {
  if (data.length > MAX_TRACKED_PROMPT_LENGTH) {
    state.currentLine = ''
    state.overflow = !data.endsWith('\r') && !data.endsWith('\n')
    return false
  }

  let historyChanged = false
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const line = state.overflow ? '' : state.currentLine.trim()
      state.currentLine = ''
      state.overflow = false
      onSubmit?.(line)
      if (line.length < 2 || state.history[state.history.length - 1] === line) continue
      state.history.push(line)
      if (state.history.length > 50) state.history.shift()
      historyChanged = true
    } else if (character === '\b' || character === '\x7f') {
      if (!state.overflow) state.currentLine = state.currentLine.slice(0, -1)
    } else if (character === '\x15') {
      state.currentLine = ''
      state.overflow = false
    } else if (character >= ' ' && !state.overflow) {
      if (state.currentLine.length < MAX_TRACKED_PROMPT_LENGTH) {
        state.currentLine += character
      } else {
        state.currentLine = ''
        state.overflow = true
      }
    }
  }
  return historyChanged
}

export async function writePtyChunked(id: string, text: string, bracketed: boolean): Promise<void> {
  const open = bracketed ? '\x1b[200~' : ''
  const close = bracketed ? '\x1b[201~' : ''

  if (text.length <= PASTE_CHUNK_SIZE) {
    await writePtyWithTimeout(id, `${open}${text}${close}`)
    return
  }

  let failure: unknown = null
  let opened = false
  try {
    if (open) {
      await writePtyWithTimeout(id, open)
      opened = true
    }
    let index = 0
    let chunkCount = 0
    while (index < text.length) {
      let end = Math.min(index + PASTE_CHUNK_SIZE, text.length)
      // Never split a UTF-16 surrogate pair across IPC calls.
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1
      }
      await writePtyWithTimeout(id, text.slice(index, end))
      index = end
      chunkCount += 1
      if (index < text.length && chunkCount % PASTE_YIELD_EVERY_CHUNKS === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }
    }
  } catch (error) {
    failure = error
  }

  // A missing closing marker leaves Claude/Codex stuck in bracketed-paste mode.
  if (opened && close) {
    try {
      await writePtyWithTimeout(id, close)
    } catch (error) {
      if (failure === null) failure = error
    }
  }
  if (failure !== null) throw failure
}
