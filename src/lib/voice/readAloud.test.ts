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
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'L', ...init })

  it('is Ctrl+Shift+L, or ⌘⇧L on macOS', () => {
    expect(isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(isReadAloudShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(true)
    // Ctrl+Shift+L on macOS stays with the terminal.
    expect(isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true }), true)).toBe(false)
    expect(isReadAloudShortcut(key({ ctrlKey: true }), false)).toBe(false)
    expect(isReadAloudShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(
      false,
    )
  })
})
