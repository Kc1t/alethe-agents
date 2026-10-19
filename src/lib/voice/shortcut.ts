import { formatShortcut } from '../platform'

export type Accelerator = {
  /** CmdOrCtrl: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
  /** `KeyboardEvent.code`, which does not change with Alt or the keyboard layout. */
  code: string
}

export type KeyState = {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MODIFIERS: Record<string, keyof Omit<Accelerator, 'code'>> = {
  cmdorctrl: 'mod',
  commandorcontrol: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
}

function keyCode(key: string): string | null {
  if (/^space$/i.test(key)) return 'Space'
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase()
  return null
}

export function parseAccelerator(value: string): Accelerator | null {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  const last = parts.pop()
  if (!last) return null
  const code = keyCode(last)
  if (!code) return null
  const accelerator: Accelerator = {
    mod: false,
    ctrl: false,
    meta: false,
    shift: false,
    alt: false,
    code,
  }
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (!modifier) return null
    accelerator[modifier] = true
  }
  return accelerator
}

export function matchesAccelerator(
  event: KeyState,
  accelerator: Accelerator,
  mac: boolean,
): { matched: boolean; jev: boolean } {
  const ctrl = accelerator.ctrl || (accelerator.mod && !mac)
  const meta = accelerator.meta || (accelerator.mod && mac)
  const matched =
    event.code === accelerator.code &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.shiftKey === accelerator.shift &&
    (accelerator.alt ? event.altKey : true)
  return { matched, jev: matched && !accelerator.alt && event.altKey }
}

export function isAcceleratorRelease(
  event: Pick<KeyState, 'code'>,
  accelerator: Accelerator,
  mac: boolean,
): boolean {
  if (event.code === accelerator.code) return true
  const ctrl = accelerator.ctrl || (accelerator.mod && !mac)
  const meta = accelerator.meta || (accelerator.mod && mac)
  return (
    (ctrl && event.code.startsWith('Control')) ||
    (meta && event.code.startsWith('Meta')) ||
    (accelerator.shift && event.code.startsWith('Shift')) ||
    (accelerator.alt && event.code.startsWith('Alt'))
  )
}

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/

function recordableKey(code: string): string | null {
  if (code === 'Space') return 'Space'
  const letter = code.match(/^Key([A-Z])$/)
  if (letter) return letter[1]
  const digit = code.match(/^Digit([0-9])$/)
  if (digit) return digit[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return null
}

export type RecordedAccelerator =
  | { accelerator: string }
  | { error: 'needs-modifier' | 'alt-reserved' | 'unsupported-key' }
  | { cancel: true }
  | { pending: true }

/** Turns a key press in the shortcut recorder into an accelerator, or says why it cannot be one. */
export function acceleratorFromKeyEvent(
  event: KeyState & { key: string },
  mac: boolean,
): RecordedAccelerator {
  if (event.key === 'Escape' || event.code === 'Escape') return { cancel: true }
  if (MODIFIER_CODES.test(event.code)) return { pending: true }
  if (event.altKey) return { error: 'alt-reserved' }
  const key = recordableKey(event.code)
  if (!key) return { error: 'unsupported-key' }
  const parts: string[] = []
  if (mac) {
    if (event.metaKey) parts.push('CmdOrCtrl')
    if (event.ctrlKey) parts.push('Ctrl')
  } else if (event.ctrlKey || event.metaKey) {
    parts.push('CmdOrCtrl')
  }
  // Shift alone would make a typing chord (Shift+K is just "K"), so only function keys allow it.
  const needsCmdOrCtrl = parts.length === 0 && !/^F\d+$/.test(key)
  if (event.shiftKey) parts.push('Shift')
  if (needsCmdOrCtrl) return { error: 'needs-modifier' }
  return { accelerator: [...parts, key].join('+') }
}

/** An accelerator as the person reads it: `CmdOrCtrl+Shift+J` is ⌘⇧J on macOS, Ctrl+Shift+J elsewhere. */
export function acceleratorLabel(shortcut: string): string {
  return formatShortcut(shortcut.replace(/CmdOrCtrl|CommandOrControl/i, 'Ctrl'))
}
