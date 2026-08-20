import type { BrowserKeyInput, BrowserMouseInput } from '../../lib/tauri'

const ALT = 1
const CTRL = 2
const META = 4
const SHIFT = 8

type ModifierSource = {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function modifiersOf(event: ModifierSource): number {
  return (
    (event.altKey ? ALT : 0) |
    (event.ctrlKey ? CTRL : 0) |
    (event.metaKey ? META : 0) |
    (event.shiftKey ? SHIFT : 0)
  )
}

export type FrameGeometry = { deviceWidth: number; deviceHeight: number }
export type SurfaceRect = { left: number; top: number; width: number; height: number }

/**
 * Canvas coordinates are in CSS pixels of the pane; the browser expects them in the page viewport.
 * The two only coincide while the pane happens to match the emulated viewport, so a click sent
 * unscaled lands somewhere else entirely as soon as they drift.
 */
export function toPageCoords(
  point: { clientX: number; clientY: number },
  rect: SurfaceRect,
  frame: FrameGeometry,
): { x: number; y: number } {
  const scaleX = rect.width > 0 && frame.deviceWidth > 0 ? frame.deviceWidth / rect.width : 1
  const scaleY = rect.height > 0 && frame.deviceHeight > 0 ? frame.deviceHeight / rect.height : 1
  return {
    x: Math.round((point.clientX - rect.left) * scaleX),
    y: Math.round((point.clientY - rect.top) * scaleY),
  }
}

const BUTTONS: BrowserMouseInput['button'][] = ['left', 'middle', 'right', 'back']

export function mouseButtonOf(button: number): BrowserMouseInput['button'] {
  return BUTTONS[button] ?? 'left'
}

// `keyCode` is deprecated and absent on synthetic events, but Chromium ignores a key event whose
// virtual key code is missing, so the ones that carry meaning are mapped by name.
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
}

export function virtualKeyOf(key: string, keyCode?: number): number | undefined {
  const mapped = VIRTUAL_KEYS[key]
  if (mapped !== undefined) return mapped
  if (keyCode) return keyCode
  if (key.length === 1) return key.toUpperCase().charCodeAt(0)
  return undefined
}

type KeySource = ModifierSource & {
  key: string
  code?: string
  keyCode?: number
}

/**
 * A printable key carries `text` so the page receives the character; a chorded one must not, or
 * Ctrl+C would type a "c" into the page instead of copying.
 */
export function toKeyInput(kind: BrowserKeyInput['kind'], event: KeySource): BrowserKeyInput {
  const modifiers = modifiersOf(event)
  const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
  return {
    kind,
    key: event.key,
    code: event.code,
    modifiers,
    ...(printable && kind === 'keyDown' ? { text: event.key } : {}),
    ...(() => {
      const virtual = virtualKeyOf(event.key, event.keyCode)
      return virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }
    })(),
  }
}

/**
 * Keys that belong to Alethe rather than to the page. Without this the pane swallows the shortcuts
 * that move between panes, and the only way out is the mouse.
 */
export function isAppShortcut(event: ModifierSource & { key: string }): boolean {
  if (event.key === 'Escape') return true
  if (!event.ctrlKey && !event.metaKey) return false
  return ['Tab', 'w', 'W', 't', 'T', 'n', 'N', ',', 'k', 'K'].includes(event.key)
}
