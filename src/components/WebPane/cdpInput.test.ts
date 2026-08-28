import { describe, expect, it } from 'vitest'

import {
  isAppShortcut,
  modifiersOf,
  mouseButtonOf,
  toKeyInput,
  toPageCoords,
  virtualKeyOf,
} from './cdpInput'

const noModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('modifiersOf', () => {
  it('packs each modifier into its own bit', () => {
    expect(modifiersOf(noModifiers)).toBe(0)
    expect(modifiersOf({ ...noModifiers, altKey: true })).toBe(1)
    expect(modifiersOf({ ...noModifiers, ctrlKey: true })).toBe(2)
    expect(modifiersOf({ ...noModifiers, metaKey: true })).toBe(4)
    expect(modifiersOf({ ...noModifiers, shiftKey: true })).toBe(8)
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15)
  })
})

describe('toPageCoords', () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 }

  it('subtracts the pane origin so the page sees its own coordinates', () => {
    const point = { clientX: 150, clientY: 90 }
    expect(toPageCoords(point, rect, { deviceWidth: 800, deviceHeight: 600 })).toEqual({
      x: 50,
      y: 40,
    })
  })

  it('scales when the emulated viewport differs from the pane', () => {
    const point = { clientX: 500, clientY: 350 }
    expect(toPageCoords(point, rect, { deviceWidth: 1600, deviceHeight: 1200 })).toEqual({
      x: 800,
      y: 600,
    })
  })

  it('falls back to one-to-one instead of dividing by zero', () => {
    const collapsed = { left: 0, top: 0, width: 0, height: 0 }
    expect(
      toPageCoords({ clientX: 30, clientY: 40 }, collapsed, {
        deviceWidth: 800,
        deviceHeight: 600,
      }),
    ).toEqual({ x: 30, y: 40 })

    expect(
      toPageCoords({ clientX: 130, clientY: 90 }, rect, {
        deviceWidth: 0,
        deviceHeight: 0,
      }),
    ).toEqual({ x: 30, y: 40 })
  })
})

describe('mouseButtonOf', () => {
  it('maps the DOM button numbers and refuses to invent one', () => {
    expect(mouseButtonOf(0)).toBe('left')
    expect(mouseButtonOf(1)).toBe('middle')
    expect(mouseButtonOf(2)).toBe('right')
    expect(mouseButtonOf(9)).toBe('left')
  })
})

describe('virtualKeyOf', () => {
  it('names the keys that carry meaning', () => {
    expect(virtualKeyOf('Enter')).toBe(13)
    expect(virtualKeyOf('Backspace')).toBe(8)
    expect(virtualKeyOf('ArrowLeft')).toBe(37)
  })

  it('derives a code for a printable key when the event has none', () => {
    expect(virtualKeyOf('a')).toBe(65)
    expect(virtualKeyOf('A')).toBe(65)
  })

  it('prefers the event keyCode over guessing', () => {
    expect(virtualKeyOf('F5', 116)).toBe(116)
    expect(virtualKeyOf('Unidentified')).toBeUndefined()
  })
})

describe('toKeyInput', () => {
  it('sends the character for a plain printable key', () => {
    const input = toKeyInput('keyDown', { ...noModifiers, key: 'a', code: 'KeyA' })
    expect(input.text).toBe('a')
    expect(input.windowsVirtualKeyCode).toBe(65)
    expect(input.code).toBe('KeyA')
  })

  it('omits the text on a chord, so Ctrl+C copies instead of typing a c', () => {
    const input = toKeyInput('keyDown', {
      ...noModifiers,
      ctrlKey: true,
      key: 'c',
      code: 'KeyC',
    })
    expect(input.text).toBeUndefined()
    expect(input.modifiers).toBe(2)
  })

  it('never attaches text to a key release', () => {
    const input = toKeyInput('keyUp', { ...noModifiers, key: 'a', code: 'KeyA' })
    expect(input.text).toBeUndefined()
  })
})

describe('isAppShortcut', () => {
  it('keeps the shortcuts that move around Alethe out of the page', () => {
    expect(isAppShortcut({ ...noModifiers, key: 'Escape' })).toBe(true)
    expect(isAppShortcut({ ...noModifiers, ctrlKey: true, key: 'Tab' })).toBe(true)
    expect(isAppShortcut({ ...noModifiers, ctrlKey: true, key: 'w' })).toBe(true)
  })

  it('lets ordinary typing and page shortcuts through', () => {
    expect(isAppShortcut({ ...noModifiers, key: 'a' })).toBe(false)
    expect(isAppShortcut({ ...noModifiers, key: 'Tab' })).toBe(false)
    expect(isAppShortcut({ ...noModifiers, ctrlKey: true, key: 'a' })).toBe(false)
  })
})
