import { describe, expect, it } from 'vitest'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  shouldScrollHostScrollback,
  shouldUseNativeClipboardPaste,
} from './terminalInput'

describe('normalizePastedText', () => {
  it('converts clipboard newlines to PTY carriage returns', () => {
    expect(normalizePastedText('one\r\ntwo\nthree\r')).toBe('one\rtwo\rthree\r')
  })
})

describe('shouldUseNativeClipboardPaste', () => {
  it('lets OpenCode handle Ctrl+V so clipboard images attach without path injection', () => {
    expect(shouldUseNativeClipboardPaste('opencode')).toBe(true)
    expect(shouldUseNativeClipboardPaste('claude')).toBe(false)
    expect(shouldUseNativeClipboardPaste('shell')).toBe(false)
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
    expect(getTerminalScrollbackRows()).toBe(50_000)
  })

  it('scales live buffers to the configured memory budget', () => {
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 1536 })).toBe(12_000)
    expect(getTerminalScrollbackRows({ agent: false, memoryBudgetMb: 1536 })).toBe(5_000)
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 4096 })).toBe(25_000)
    expect(getTerminalScrollbackRows({ agent: true, memoryBudgetMb: 32_768 })).toBe(50_000)
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
