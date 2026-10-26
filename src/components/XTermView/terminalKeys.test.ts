import { describe, expect, it } from 'vitest'

import { resolveTerminalKey, type TerminalKeyContext, type TerminalKeyEvent } from './terminalKeys'

type Chord = Partial<Omit<TerminalKeyEvent, 'key'>>

function press(key: string, chord: Chord = {}): TerminalKeyEvent {
  return {
    type: 'keydown',
    key,
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...chord,
  }
}

function context(mac: boolean, overrides: Partial<TerminalKeyContext> = {}): TerminalKeyContext {
  return { mac, readOnly: false, selection: () => '', ...overrides }
}

const CTRL = { ctrlKey: true }
const CMD = { metaKey: true }
const selected = { selection: () => 'picked text' }

describe('resolveTerminalKey on macOS', () => {
  const mac = context(true)

  it('hands every physical Ctrl chord to the PTY', () => {
    for (const key of ['w', 'b', 'e', 'p', 't', 'v', 'r', 'n', 'k', '=', '-', '0']) {
      expect(resolveTerminalKey(press(key, CTRL), mac)).toEqual({ kind: 'pass' })
    }
    expect(resolveTerminalKey(press('ArrowUp', CTRL), mac)).toEqual({ kind: 'pass' })
  })

  it('treats Ctrl+C as the interrupt, even with a selection', () => {
    expect(resolveTerminalKey(press('c', CTRL), mac)).toEqual({ kind: 'interrupt' })
    expect(resolveTerminalKey(press('c', CTRL), context(true, selected))).toEqual({
      kind: 'interrupt',
    })
  })

  it('copies with Cmd+C and never interrupts with it', () => {
    expect(resolveTerminalKey(press('c', CMD), context(true, selected))).toEqual({
      kind: 'copy',
      text: 'picked text',
    })
    expect(resolveTerminalKey(press('c', CMD), mac)).toEqual({ kind: 'block' })
  })

  it('pastes with Cmd+V', () => {
    expect(resolveTerminalKey(press('v', CMD), mac)).toEqual({ kind: 'paste' })
  })

  it('keeps Cmd app shortcuts away from the PTY', () => {
    expect(resolveTerminalKey(press('b', CMD), mac)).toEqual({ kind: 'block' })
    expect(resolveTerminalKey(press('=', CMD), mac)).toEqual({ kind: 'block' })
    expect(resolveTerminalKey(press('ArrowDown', CMD), mac)).toEqual({
      kind: 'history',
      direction: 'down',
    })
  })

  it('sends the Terminal.app line-editing sequences for Option and Cmd chords', () => {
    const ALT = { altKey: true }
    expect(resolveTerminalKey(press('ArrowLeft', ALT), mac)).toEqual({
      kind: 'send',
      data: '\x1bb',
    })
    expect(resolveTerminalKey(press('ArrowRight', ALT), mac)).toEqual({
      kind: 'send',
      data: '\x1bf',
    })
    expect(resolveTerminalKey(press('Backspace', ALT), mac)).toEqual({
      kind: 'send',
      data: '\x1b\x7f',
    })
    expect(resolveTerminalKey(press('ArrowLeft', CMD), mac)).toEqual({ kind: 'send', data: '\x01' })
    expect(resolveTerminalKey(press('ArrowRight', CMD), mac)).toEqual({
      kind: 'send',
      data: '\x05',
    })
    expect(resolveTerminalKey(press('Backspace', CMD), mac)).toEqual({ kind: 'send', data: '\x15' })
    // Shift extends a selection instead; read-only terminals take no input.
    expect(resolveTerminalKey(press('ArrowLeft', { ...ALT, shiftKey: true }), mac)).toEqual({
      kind: 'pass',
    })
    expect(resolveTerminalKey(press('ArrowLeft', ALT), context(true, { readOnly: true }))).toEqual({
      kind: 'pass',
    })
  })

  it('keeps those chords to xterm on Windows/Linux', () => {
    expect(resolveTerminalKey(press('ArrowLeft', { altKey: true }), context(false))).toEqual({
      kind: 'pass',
    })
  })

  it('lets xterm handle Cmd+A (select all) and other Option chords', () => {
    expect(resolveTerminalKey(press('a', CMD), mac)).toEqual({ kind: 'pass' })
    expect(resolveTerminalKey(press('b', { altKey: true }), mac)).toEqual({ kind: 'pass' })
    expect(resolveTerminalKey(press('Enter', { altKey: true }), mac)).toEqual({ kind: 'pass' })
  })

  it('swallows Ctrl+Tab, which switches workspace tabs, but not Cmd+Tab', () => {
    expect(resolveTerminalKey(press('Tab', CTRL), mac)).toEqual({ kind: 'block' })
    expect(resolveTerminalKey(press('Tab', { ctrlKey: true, shiftKey: true }), mac)).toEqual({
      kind: 'block',
    })
    expect(resolveTerminalKey(press('Tab', CMD), mac)).toEqual({ kind: 'pass' })
  })

  it('ignores Cmd+Ctrl chords, which belong to the OS', () => {
    expect(resolveTerminalKey(press('c', { ctrlKey: true, metaKey: true }), mac)).toEqual({
      kind: 'pass',
    })
  })

  it('does not interrupt a read-only terminal', () => {
    expect(resolveTerminalKey(press('c', CTRL), context(true, { readOnly: true }))).toEqual({
      kind: 'pass',
    })
  })
})

describe('resolveTerminalKey on Windows/Linux', () => {
  const win = context(false)

  it('copies a selection with Ctrl+C and interrupts without one', () => {
    expect(resolveTerminalKey(press('c', CTRL), context(false, selected))).toEqual({
      kind: 'copy',
      text: 'picked text',
    })
    expect(resolveTerminalKey(press('c', CTRL), win)).toEqual({ kind: 'interrupt' })
  })

  it('keeps the existing Ctrl shortcuts', () => {
    expect(resolveTerminalKey(press('v', CTRL), win)).toEqual({ kind: 'paste' })
    expect(resolveTerminalKey(press('b', CTRL), win)).toEqual({ kind: 'block' })
    expect(resolveTerminalKey(press('-', CTRL), win)).toEqual({ kind: 'block' })
    expect(resolveTerminalKey(press('ArrowUp', CTRL), win)).toEqual({
      kind: 'history',
      direction: 'up',
    })
    expect(resolveTerminalKey(press('Tab', CTRL), win)).toEqual({ kind: 'block' })
  })

  it('passes everything else through', () => {
    expect(resolveTerminalKey(press('w', CTRL), win)).toEqual({ kind: 'pass' })
    expect(resolveTerminalKey(press('B', { ctrlKey: true, shiftKey: true }), win)).toEqual({
      kind: 'pass',
    })
    expect(resolveTerminalKey(press('c', { ctrlKey: true, altKey: true }), win)).toEqual({
      kind: 'pass',
    })
    expect(resolveTerminalKey(press('x'), win)).toEqual({ kind: 'pass' })
    expect(resolveTerminalKey({ ...press('c', CTRL), type: 'keyup' }, win)).toEqual({
      kind: 'pass',
    })
  })

  it('does not paste or interrupt in a read-only terminal', () => {
    const readOnly = context(false, { readOnly: true })
    expect(resolveTerminalKey(press('v', CTRL), readOnly)).toEqual({ kind: 'pass' })
    expect(resolveTerminalKey(press('c', CTRL), readOnly)).toEqual({ kind: 'pass' })
  })
})
