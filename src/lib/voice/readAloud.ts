import { formatShortcut, isMacOS } from '../platform'

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

/** Reads the focused terminal's selection, or else the clipboard, from anywhere in the app. */
export const READ_ALOUD_SHORTCUT = 'Ctrl+Shift+L'

export function readAloudShortcutLabel(): string {
  return formatShortcut(READ_ALOUD_SHORTCUT)
}

/** ⌘⇧L on macOS (Ctrl+Shift+L there is left to the terminal), Ctrl+Shift+L elsewhere. */
export function isReadAloudShortcut(event: KeyboardEvent, mac: boolean = isMacOS()): boolean {
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return primary && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l'
}
