import { describe, expect, it } from 'vitest'

import {
  formatDroppedPaths,
  getTerminalScrollbackRows,
  getWheelScrollLines,
  normalizePastedText,
  decideWheelAction,
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

describe('decideWheelAction', () => {
  const wheel = (
    bufferType: 'normal' | 'alternate',
    shiftKey: boolean,
    mouseTrackingActive: boolean,
  ) => decideWheelAction({ bufferType, shiftKey, mouseTrackingActive })

  it('scrolls the host buffer in a plain shell', () => {
    expect(wheel('normal', false, false)).toBe('host')
  })

  it('forwards to a full-screen app that asked for mouse events', () => {
    // OpenCode enables mouse tracking, so it scrolls its own view — verified in the recorded PTY
    // stream, which turns it on nine times in one session.
    expect(wheel('alternate', false, true)).toBe('app')
  })

  it('swallows the wheel for a full-screen app that did NOT ask for mouse events', () => {
    // The regression this exists for. xterm's default is to convert the wheel into cursor keys when
    // the alternate buffer has no scrollback — and Claude Code, which never enables mouse tracking
    // (also verified in the recorded stream), reads those arrows as input. Scrolling silently moved
    // through its prompt history. Doing nothing is strictly better than typing for the user.
    expect(wheel('alternate', false, false)).toBe('ignore')
  })

  it('lets Shift+wheel force host scrollback whatever the app is doing', () => {
    expect(wheel('alternate', true, false)).toBe('host')
    expect(wheel('alternate', true, true)).toBe('host')
    expect(wheel('normal', true, false)).toBe('host')
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
