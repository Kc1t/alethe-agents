import { describe, expect, it } from 'vitest'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
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

describe('shouldScrollHostScrollback', () => {
  it('scrolls the host buffer in a plain shell', () => {
    expect(shouldScrollHostScrollback('normal', false)).toBe(true)
  })

  it('forwards the wheel to TUIs in the alternate buffer', () => {
    // claude/codex run in the alternate screen (no host scrollback) — let the app scroll itself.
    expect(shouldScrollHostScrollback('alternate', false)).toBe(false)
  })

  it('lets Shift+wheel force host scrollback even in the alternate buffer', () => {
    expect(shouldScrollHostScrollback('alternate', true)).toBe(true)
    expect(shouldScrollHostScrollback('normal', true)).toBe(true)
  })
})

describe('formatDroppedPaths', () => {
  it('quotes paths containing backslashes or whitespace', () => {
    expect(formatDroppedPaths(['C:\\a\\b.txt'])).toBe('"C:\\a\\b.txt" ')
    expect(formatDroppedPaths(['C:\\meu path\\f.txt'])).toBe('"C:\\meu path\\f.txt" ')
  })

  it('leaves simple slash-free paths unquoted with trailing space', () => {
    expect(formatDroppedPaths(['file.txt'])).toBe('file.txt ')
  })

  it('joins multiple paths, quoting those with backslashes or spaces', () => {
    expect(formatDroppedPaths(['a.txt', 'C:\\my dir\\b.txt'])).toBe('a.txt "C:\\my dir\\b.txt" ')
  })

  it('returns empty string when no valid paths', () => {
    expect(formatDroppedPaths([])).toBe('')
    expect(formatDroppedPaths(['', ''])).toBe('')
  })
})
