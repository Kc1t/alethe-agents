import { describe, expect, it } from 'vitest'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  resolveWheelTarget,
} from './terminalInput'

describe('normalizePastedText', () => {
  it('converts clipboard newlines to PTY carriage returns', () => {
    expect(normalizePastedText('one\r\ntwo\nthree\r')).toBe('one\rtwo\rthree\r')
  })
})

describe('getWheelScrollLines', () => {
  it('always scrolls at least one line for pixel wheel events', () => {
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: 1 }, 18)).toBe(1)
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: -1 }, 18)).toBe(-1)
  })

  it('preserves larger wheel intent across delta modes', () => {
    expect(getWheelScrollLines({ deltaMode: 0, deltaY: 40 }, 20)).toBe(2)
    expect(getWheelScrollLines({ deltaMode: 1, deltaY: 3 }, 20)).toBe(3)
    expect(getWheelScrollLines({ deltaMode: 2, deltaY: -1 }, 20)).toBe(-10)
  })
})

describe('getTerminalScrollbackRows', () => {
  it('keeps enough rows for long agent chats', () => {
    expect(getTerminalScrollbackRows()).toBeGreaterThanOrEqual(10_000)
  })

  it('scales live buffers to the configured memory budget', () => {
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 1536 })).toBe(6_000)
    expect(getTerminalScrollbackRows({ agent: false, memoryBudgetMb: 1536 })).toBe(3_000)
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 4096 })).toBe(10_000)
  })
})

describe('resolveWheelTarget', () => {
  const wheel = (overrides: Partial<Parameters<typeof resolveWheelTarget>[0]> = {}) =>
    resolveWheelTarget({ bufferType: 'normal', shiftKey: false, sessionAlive: true, ...overrides })

  it('scrolls the pane history in a plain shell', () => {
    expect(wheel()).toBe('scrollback')
    expect(wheel({ sessionAlive: false })).toBe('scrollback')
  })

  it('lets Shift+wheel force the pane history anywhere', () => {
    expect(wheel({ bufferType: 'alternate', shiftKey: true })).toBe('scrollback')
  })

  it('leaves the wheel to the live alternate-screen TUI', () => {
    // claude in fullscreen rendering owns the screen and scrolls its own transcript.
    expect(wheel({ bufferType: 'alternate' })).toBe('app')
  })

  it('recovers a screen whose session died owning it', () => {
    // A fullscreen agent killed before undoing its modes leaves the wheel with nobody.
    expect(wheel({ bufferType: 'alternate', sessionAlive: false })).toBe('recover')
  })
})

describe('formatDroppedPaths', () => {
  it('leaves space-free paths unquoted with a trailing space', () => {
    expect(formatDroppedPaths(['C:\\a\\b.txt'])).toBe('C:\\a\\b.txt ')
  })

  it('quotes paths containing whitespace', () => {
    expect(formatDroppedPaths(['C:\\meu path\\f.txt'])).toBe('"C:\\meu path\\f.txt" ')
  })

  it('joins multiple paths, quoting only those with spaces', () => {
    expect(formatDroppedPaths(['C:\\a.txt', 'C:\\my dir\\b.txt'])).toBe(
      'C:\\a.txt "C:\\my dir\\b.txt" ',
    )
  })

  it('returns empty string when no valid paths', () => {
    expect(formatDroppedPaths([])).toBe('')
    expect(formatDroppedPaths(['', ''])).toBe('')
  })
})
