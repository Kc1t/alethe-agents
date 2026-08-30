import type { WindowControlButton, WindowControlsLayout, WindowControlSide } from './tauri'

export type WindowControlsPlacementPreference = 'system' | 'left' | 'right'

const FALLBACK_RIGHT: WindowControlsLayout = {
  side: 'right',
  buttons: ['minimize', 'maximize', 'close'],
  source: 'fallback',
}

const FALLBACK_LEFT: WindowControlsLayout = {
  side: 'left',
  buttons: ['close', 'minimize', 'maximize'],
  source: 'fallback',
}

/** Apply a user preference on top of the desktop-detected layout. */
export function resolveWindowControlsLayout(
  detected: WindowControlsLayout | null | undefined,
  preference: WindowControlsPlacementPreference = 'system',
): WindowControlsLayout {
  const base = detected ?? FALLBACK_RIGHT
  if (preference === 'system') return base
  if (preference === base.side) return base
  return {
    side: preference,
    buttons: preference === 'left' ? FALLBACK_LEFT.buttons : FALLBACK_RIGHT.buttons,
    source: base.source,
  }
}

export function isWindowControlButton(value: string): value is WindowControlButton {
  return value === 'close' || value === 'minimize' || value === 'maximize'
}

export function isWindowControlSide(value: string): value is WindowControlSide {
  return value === 'left' || value === 'right'
}
