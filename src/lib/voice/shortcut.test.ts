import { describe, expect, it } from 'vitest'

import {
  acceleratorFromKeyEvent,
  isAcceleratorRelease,
  matchesAccelerator,
  parseAccelerator,
} from './shortcut'

const key = (
  code: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe('parseAccelerator', () => {
  it('reads modifiers and the key', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+Space')).toEqual({
      mod: true,
      ctrl: false,
      meta: false,
      shift: true,
      alt: false,
      code: 'Space',
    })
    expect(parseAccelerator('Ctrl+Alt+K')?.code).toBe('KeyK')
    expect(parseAccelerator('F9')?.code).toBe('F9')
    expect(parseAccelerator('Shift+5')?.code).toBe('Digit5')
  })

  it('refuses what it cannot bind', () => {
    expect(parseAccelerator('')).toBeNull()
    expect(parseAccelerator('Ctrl+Shift')).toBeNull()
    expect(parseAccelerator('Hyper+K')).toBeNull()
    expect(parseAccelerator('Ctrl+Banana')).toBeNull()
  })
})

describe('matchesAccelerator', () => {
  const chord = parseAccelerator('CmdOrCtrl+Shift+Space')!

  it('maps CmdOrCtrl to Cmd on macOS and Ctrl elsewhere', () => {
    expect(
      matchesAccelerator(key('Space', { metaKey: true, shiftKey: true }), chord, true).matched,
    ).toBe(true)
    expect(
      matchesAccelerator(key('Space', { ctrlKey: true, shiftKey: true }), chord, false).matched,
    ).toBe(true)
    expect(
      matchesAccelerator(key('Space', { ctrlKey: true, shiftKey: true }), chord, true).matched,
    ).toBe(false)
  })

  it('reads an extra Alt as the Jev modifier', () => {
    expect(
      matchesAccelerator(
        key('Space', { ctrlKey: true, shiftKey: true, altKey: true }),
        chord,
        false,
      ),
    ).toEqual({
      matched: true,
      jev: true,
    })
  })

  it('needs every modifier', () => {
    expect(matchesAccelerator(key('Space', { ctrlKey: true }), chord, false).matched).toBe(false)
  })
})

describe('isAcceleratorRelease', () => {
  const chord = parseAccelerator('CmdOrCtrl+Shift+Space')!
  it('ends push-to-talk when the key or any of its modifiers comes up', () => {
    expect(isAcceleratorRelease({ code: 'Space' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'ShiftLeft' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'ControlRight' }, chord, false)).toBe(true)
    expect(isAcceleratorRelease({ code: 'MetaLeft' }, chord, true)).toBe(true)
    expect(isAcceleratorRelease({ code: 'KeyA' }, chord, false)).toBe(false)
  })
})

describe('acceleratorFromKeyEvent', () => {
  const ev = (
    code: string,
    mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {},
    key = code,
  ) => ({
    code,
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  })

  it('stores Cmd on macOS and Ctrl elsewhere as CmdOrCtrl', () => {
    expect(acceleratorFromKeyEvent(ev('Space', { metaKey: true, shiftKey: true }), true)).toEqual({
      accelerator: 'CmdOrCtrl+Shift+Space',
    })
    expect(acceleratorFromKeyEvent(ev('KeyK', { ctrlKey: true }), false)).toEqual({
      accelerator: 'CmdOrCtrl+K',
    })
  })

  it('keeps a real Ctrl on macOS distinct from Cmd', () => {
    expect(acceleratorFromKeyEvent(ev('KeyK', { ctrlKey: true }), true)).toEqual({
      accelerator: 'Ctrl+K',
    })
  })

  it('refuses Alt, a key without a modifier, and unsupported keys', () => {
    expect(acceleratorFromKeyEvent(ev('KeyK', { metaKey: true, altKey: true }), true)).toEqual({
      error: 'alt-reserved',
    })
    expect(acceleratorFromKeyEvent(ev('KeyK'), true)).toEqual({ error: 'needs-modifier' })
    expect(acceleratorFromKeyEvent(ev('BracketLeft', { metaKey: true }), true)).toEqual({
      error: 'unsupported-key',
    })
  })

  it('accepts a function key alone', () => {
    expect(acceleratorFromKeyEvent(ev('F9'), false)).toEqual({ accelerator: 'F9' })
  })

  it('refuses Shift as the only modifier unless the key is F1-F24', () => {
    expect(acceleratorFromKeyEvent(ev('KeyK', { shiftKey: true }), true)).toEqual({
      error: 'needs-modifier',
    })
    expect(acceleratorFromKeyEvent(ev('Space', { shiftKey: true }), false)).toEqual({
      error: 'needs-modifier',
    })
    expect(acceleratorFromKeyEvent(ev('F9', { shiftKey: true }), false)).toEqual({
      accelerator: 'Shift+F9',
    })
    expect(acceleratorFromKeyEvent(ev('KeyK', { ctrlKey: true, shiftKey: true }), true)).toEqual({
      accelerator: 'Ctrl+Shift+K',
    })
    expect(acceleratorFromKeyEvent(ev('KeyK', { metaKey: true, shiftKey: true }), false)).toEqual({
      accelerator: 'CmdOrCtrl+Shift+K',
    })
  })

  it('cancels on Escape and waits while only modifiers are down', () => {
    expect(acceleratorFromKeyEvent(ev('Escape', {}, 'Escape'), true)).toEqual({ cancel: true })
    expect(acceleratorFromKeyEvent(ev('ShiftLeft', { shiftKey: true }, 'Shift'), true)).toEqual({
      pending: true,
    })
  })

  it('produces accelerators parseAccelerator accepts', () => {
    const result = acceleratorFromKeyEvent(ev('Digit5', { metaKey: true, shiftKey: true }), true)
    expect('accelerator' in result && parseAccelerator(result.accelerator)).toBeTruthy()
  })
})
