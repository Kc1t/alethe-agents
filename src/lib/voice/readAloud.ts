import { isMacOS } from '../platform'
import { acceleratorLabel, matchesAccelerator, parseAccelerator } from './shortcut'

/**
 * How a pane asks the voice conversation to read text aloud. The controller registers itself
 * while voice conversation is on; with it off there is no reader and panes offer no such action.
 */
type Reader = (text: string) => void

let reader: Reader | null = null

export function registerReadAloud(next: Reader): () => void {
  reader = next
  return () => {
    if (reader === next) reader = null
  }
}

export function canReadAloud(): boolean {
  return reader !== null
}

/** False when nobody reads (voice conversation is off). */
export function readAloud(text: string): boolean {
  if (!reader || !text.trim()) return false
  reader(text)
  return true
}

/** The text selected in the terminal that has focus: its own selection, or one its TUI copied. */
type SelectionSource = () => string

let focusedSelection: SelectionSource | null = null

/** A terminal took focus; the returned function lets go unless another took it since. */
export function setFocusedSelection(source: SelectionSource): () => void {
  focusedSelection = source
  return () => {
    if (focusedSelection === source) focusedSelection = null
  }
}

export function currentSelection(): string {
  return focusedSelection?.() ?? ''
}

/** The read-aloud accelerator (`voiceReadAloudShortcut`) as the person reads it: ⌘⇧L, Ctrl+Shift+L. */
export function readAloudShortcutLabel(shortcut: string): string {
  return acceleratorLabel(shortcut)
}

/**
 * The read-aloud shortcut was pressed: `shortcut` is an accelerator (`CmdOrCtrl+Shift+L` is ⌘⇧L
 * on macOS, Ctrl+Shift+L elsewhere). An unparsable one never matches.
 */
export function isReadAloudShortcut(
  event: KeyboardEvent,
  shortcut: string,
  mac: boolean = isMacOS(),
): boolean {
  const accelerator = parseAccelerator(shortcut)
  return (
    accelerator !== null && !event.altKey && matchesAccelerator(event, accelerator, mac).matched
  )
}
