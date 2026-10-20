import { describe, expect, it } from 'vitest'

import {
  createWheelScrollAccumulator,
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollStep,
  normalizePastedText,
  shouldScrollHostScrollback,
} from './terminalInput'

describe('normalizePastedText', () => {
  it('converts clipboard newlines to PTY carriage returns', () => {
    expect(normalizePastedText('one\r\ntwo\nthree\r')).toBe('one\rtwo\rthree\r')
  })
})

describe('getWheelScrollStep', () => {
  it('carries sub-line pixel deltas instead of rounding each one up to a line', () => {
    expect(getWheelScrollStep({ deltaMode: 0, deltaY: 1 }, 18)).toEqual({
      lines: 0,
      remainderPx: 1,
    })
    expect(getWheelScrollStep({ deltaMode: 0, deltaY: 10 }, 18, 10)).toEqual({
      lines: 1,
      remainderPx: 2,
    })
  })

  it('preserves larger wheel intent across delta modes', () => {
    expect(getWheelScrollStep({ deltaMode: 0, deltaY: 40 }, 20).lines).toBe(2)
    expect(getWheelScrollStep({ deltaMode: 1, deltaY: 3 }, 20).lines).toBe(3)
    expect(getWheelScrollStep({ deltaMode: 2, deltaY: -1 }, 20).lines).toBe(-10)
  })

  it('leaves line and page deltas untouched and drops any carried remainder', () => {
    expect(getWheelScrollStep({ deltaMode: 1, deltaY: 3 }, 20, 15)).toEqual({
      lines: 3,
      remainderPx: 0,
    })
    expect(getWheelScrollStep({ deltaMode: 2, deltaY: 1 }, 20, 15)).toEqual({
      lines: 10,
      remainderPx: 0,
    })
  })

  it('starts over when the scroll direction reverses', () => {
    expect(getWheelScrollStep({ deltaMode: 0, deltaY: -5 }, 18, 17)).toEqual({
      lines: 0,
      remainderPx: -5,
    })
  })

  it('ignores events without vertical movement', () => {
    expect(getWheelScrollStep({ deltaMode: 0, deltaY: 0 }, 18, 7)).toEqual({
      lines: 0,
      remainderPx: 7,
    })
  })
})

describe('createWheelScrollAccumulator', () => {
  it('scrolls a trackpad momentum burst by its real distance, not one line per event', () => {
    const wheel = createWheelScrollAccumulator()
    let lines = 0
    for (let i = 0; i < 36; i += 1) lines += wheel.next({ deltaMode: 0, deltaY: 2 }, 18)
    // 36 events × 2px = 72px = 4 lines of 18px (the old rounding scrolled 36 lines).
    expect(lines).toBe(4)
  })

  it('scrolls upwards the same way', () => {
    const wheel = createWheelScrollAccumulator()
    let lines = 0
    for (let i = 0; i < 9; i += 1) lines += wheel.next({ deltaMode: 0, deltaY: -4 }, 18)
    expect(lines).toBe(-2)
  })

  it('keeps each terminal’s remainder separate', () => {
    const first = createWheelScrollAccumulator()
    const second = createWheelScrollAccumulator()
    expect(first.next({ deltaMode: 0, deltaY: 12 }, 18)).toBe(0)
    expect(second.next({ deltaMode: 0, deltaY: 12 }, 18)).toBe(0)
    expect(first.next({ deltaMode: 0, deltaY: 12 }, 18)).toBe(1)
  })

  it('keeps mouse-wheel line steps exact', () => {
    const wheel = createWheelScrollAccumulator()
    expect(wheel.next({ deltaMode: 1, deltaY: 3 }, 18)).toBe(3)
    expect(wheel.next({ deltaMode: 1, deltaY: -3 }, 18)).toBe(-3)
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
