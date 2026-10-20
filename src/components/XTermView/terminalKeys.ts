import { isControlModifier, isPrimaryModifier } from '../../lib/platform'

export type TerminalKeyEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>

export type TerminalKeyAction =
  /** Let xterm encode the key for the PTY. */
  | { kind: 'pass' }
  /** Swallow the key: an app shortcut owns it and the PTY must not see it. */
  | { kind: 'block' }
  | { kind: 'copy'; text: string }
  | { kind: 'paste' }
  /** The interrupt key: counts toward the double-press force kill, then reaches the PTY. */
  | { kind: 'interrupt' }
  | { kind: 'history'; direction: 'up' | 'down' }
  /** Bytes to write to the PTY in place of what xterm would encode. */
  | { kind: 'send'; data: string }

export type TerminalKeyContext = {
  mac: boolean
  readOnly: boolean
  /** Selected text, read lazily so ordinary typing never builds the selection string. */
  selection: () => string
}

const PASS: TerminalKeyAction = { kind: 'pass' }
const BLOCK: TerminalKeyAction = { kind: 'block' }

function isZoomKey(event: TerminalKeyEvent, key: string): boolean {
  return (
    key === '+' ||
    key === '=' ||
    key === '-' ||
    key === '_' ||
    key === '0' ||
    event.code === 'NumpadAdd' ||
    event.code === 'NumpadSubtract' ||
    event.code === 'Numpad0'
  )
}

/**
 * The line-editing chords of Terminal.app and iTerm2, sent as the readline/zle sequences they map
 * to: Option+Left/Right jump a word, Option+Delete deletes one, Cmd+Left/Right go to the start or
 * end of the line, Cmd+Delete deletes back to its start. Option stays a character key otherwise,
 * so Option+e and Option+n still compose accents.
 */
function macEditingKey(event: TerminalKeyEvent): string | null {
  if (event.ctrlKey || event.shiftKey) return null
  if (event.altKey && !event.metaKey) {
    if (event.key === 'ArrowLeft') return '\x1bb'
    if (event.key === 'ArrowRight') return '\x1bf'
    if (event.key === 'Backspace') return '\x1b\x7f'
  }
  if (event.metaKey && !event.altKey) {
    if (event.key === 'ArrowLeft') return '\x01'
    if (event.key === 'ArrowRight') return '\x05'
    if (event.key === 'Backspace') return '\x15'
  }
  return null
}

/**
 * Decides what a keydown inside a terminal does. App shortcuts use Cmd on macOS and Ctrl
 * elsewhere; on macOS a physical Ctrl chord always reaches the PTY untouched (^C interrupts, ^W
 * deletes a word, ^V hands the clipboard image to the agent…), and Cmd+C never interrupts.
 */
export function resolveTerminalKey(
  event: TerminalKeyEvent,
  context: TerminalKeyContext,
): TerminalKeyAction {
  if (event.type !== 'keydown') return PASS
  const { mac, readOnly } = context
  if (mac && !readOnly) {
    const data = macEditingKey(event)
    if (data !== null) return { kind: 'send', data }
  }
  if (event.altKey) return PASS
  const key = event.key.toLowerCase()

  // Ctrl+Tab switches workspace tabs (see useKeybindings); xterm would also send a Tab.
  if (event.key === 'Tab' && isControlModifier(event, mac)) return BLOCK

  if (mac && key === 'c' && event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return readOnly ? PASS : { kind: 'interrupt' }
  }

  if (!isPrimaryModifier(event, mac)) return PASS

  if (isZoomKey(event, key)) return BLOCK

  if (key === 'c') {
    const text = context.selection()
    if (text) return { kind: 'copy', text }
    // Cmd+C without a selection does nothing; elsewhere the same Ctrl+C is the interrupt.
    if (mac) return BLOCK
    if (!readOnly) return { kind: 'interrupt' }
  }

  if (key === 'v' && !readOnly) return { kind: 'paste' }

  // Ctrl+B toggles the left sidebar; the shell must not also receive it.
  if (key === 'b' && !event.shiftKey) return BLOCK

  if (!readOnly && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    return { kind: 'history', direction: event.key === 'ArrowUp' ? 'up' : 'down' }
  }
  return PASS
}
