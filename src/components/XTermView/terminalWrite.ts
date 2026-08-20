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
 * Encontra um ponto de corte seguro para o frame budget do terminal:
 * 1. Não divide pares substitutos UTF-16 (surrogate pairs / emojis / caracteres CJK/Unicode).
 * 2. Não corta no meio de sequências de escape ANSI (CSI '\x1b[...', OSC '\x1b]...', DCS, ST).
 */
export function findSafeChunkBoundary(text: string, maxTake: number): number {
  if (maxTake >= text.length) return text.length
  let take = maxTake

  // 1. Evita partir par substituto UTF-16
  if (
    take > 0 &&
    take < text.length &&
    text.charCodeAt(take - 1) >= 0xd800 &&
    text.charCodeAt(take - 1) <= 0xdbff &&
    text.charCodeAt(take) >= 0xdc00 &&
    text.charCodeAt(take) <= 0xdfff
  ) {
    take -= 1
  }

  // 2. Evita partir sequência ANSI escape (\x1b...)
  // Procura para trás pelo último caractere ESC ('\x1b') nos últimos 64 caracteres
  const lastEsc = text.lastIndexOf('\x1b', take - 1)
  if (lastEsc !== -1 && take - lastEsc < 64) {
    // Verifica se a sequência iniciada em lastEsc já foi finalizada antes de take
    let isTerminated = false
    for (let i = lastEsc + 1; i < take; i++) {
      const ch = text.charCodeAt(i)
      // Caracteres finais padrão ANSI (A-Z, a-z, ~, @) ou ST (\x07 / \x1b\\)
      if ((ch >= 0x40 && ch <= 0x7e) || ch === 0x07) {
        isTerminated = true
        break
      }
    }
    if (!isTerminated) {
      // Se não terminou antes de take, corta exatamente antes do ESC para não partir a sequência
      if (lastEsc > 0) {
        take = lastEsc
      }
    }
  }

  return take > 0 ? take : maxTake
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

// Bracketed paste (DECSET 2004): quando a app liga, envolvemos a colagem
// inteira nos marcadores 200~/201~ pra ela tratar como um bloco único. Sem
// isso, cada \r interno vira Enter e TUIs como o Claude submetem só a
// primeira linha — a colagem grande chegava cortada. Os marcadores ficam
// FORA do chunking pra nunca serem partidos no meio.
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
