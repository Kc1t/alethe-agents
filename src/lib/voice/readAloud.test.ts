import { describe, expect, it, vi } from 'vitest'

import {
  canReadAloud,
  currentSelection,
  isReadAloudShortcut,
  readAloud,
  registerReadAloud,
  setFocusedSelection,
} from './readAloud'

describe('read aloud registry', () => {
  it('reaches the registered reader until it unregisters', () => {
    const reader = vi.fn()
    const unregister = registerReadAloud(reader)
    expect(canReadAloud()).toBe(true)
    expect(readAloud('hello')).toBe(true)
    expect(readAloud('   ')).toBe(false)
    expect(reader).toHaveBeenCalledTimes(1)
    unregister()
    expect(canReadAloud()).toBe(false)
    expect(readAloud('hello')).toBe(false)
  })

  // A remounted controller registers before the old one is disposed.
  it('a stale unregister leaves the newer reader in place', () => {
    const stale = registerReadAloud(vi.fn())
    const fresh = vi.fn()
    const unregister = registerReadAloud(fresh)
    stale()
    expect(readAloud('hi')).toBe(true)
    expect(fresh).toHaveBeenCalledWith('hi')
    unregister()
  })
})

describe('focused selection', () => {
  it('follows the terminal that took focus last', () => {
    const releaseFirst = setFocusedSelection(() => 'first')
    const releaseSecond = setFocusedSelection(() => 'second')
    releaseFirst()
    expect(currentSelection()).toBe('second')
    releaseSecond()
    expect(currentSelection()).toBe('')
  })
})

describe('isReadAloudShortcut', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { code: 'KeyL', ...init })

  it('matches the accelerator: CmdOrCtrl is ⌘ on macOS and Ctrl elsewhere', () => {
    const shortcut = 'CmdOrCtrl+Shift+L'
    expect(isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true }), shortcut, false)).toBe(true)
    expect(isReadAloudShortcut(key({ metaKey: true, shiftKey: true }), shortcut, true)).toBe(true)
    // Ctrl+Shift+L on macOS stays with the terminal.
    expect(isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true }), shortcut, true)).toBe(false)
    expect(isReadAloudShortcut(key({ ctrlKey: true }), shortcut, false)).toBe(false)
    expect(
      isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), shortcut, false),
    ).toBe(false)
  })

  it('follows a changed shortcut and ignores one it cannot read', () => {
    const r = new KeyboardEvent('keydown', { code: 'KeyR', ctrlKey: true, shiftKey: true })
    expect(isReadAloudShortcut(r, 'CmdOrCtrl+Shift+R', false)).toBe(true)
    expect(isReadAloudShortcut(r, 'CmdOrCtrl+Shift+L', false)).toBe(false)
    expect(isReadAloudShortcut(r, 'nonsense', false)).toBe(false)
  })
})
