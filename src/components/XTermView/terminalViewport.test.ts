import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import {
  captureViewportAnchor,
  restoreViewport,
  restoreViewportAnchor,
  viewportDistanceFromBottom,
} from './terminalViewport'

/** Only the buffer state these helpers read and the scroll calls they make. */
function pane(baseY: number, viewportY: number) {
  const scrollToBottom = vi.fn()
  const scrollToLine = vi.fn()
  const terminal = {
    buffer: { active: { baseY, viewportY } },
    scrollToBottom,
    scrollToLine,
  } as unknown as Terminal
  return { terminal, scrollToBottom, scrollToLine }
}

describe('viewportDistanceFromBottom', () => {
  it('counts the lines between the view and the newest output', () => {
    expect(viewportDistanceFromBottom(pane(120, 108).terminal)).toBe(12)
  })

  it('never reports a negative distance', () => {
    expect(viewportDistanceFromBottom(pane(10, 12).terminal)).toBe(0)
  })
})

describe('restoreViewport', () => {
  it('puts the reader back by distance, not by line number', () => {
    // A resync rebuilt the buffer, so line 108 is not what it was: 12 from the end still is.
    const { terminal, scrollToBottom, scrollToLine } = pane(200, 0)

    restoreViewport(terminal, 12)

    expect(scrollToLine).toHaveBeenCalledWith(188)
    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('follows the output again for a reader who was at the bottom', () => {
    const { terminal, scrollToBottom, scrollToLine } = pane(200, 200)

    restoreViewport(terminal, 0)

    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(scrollToLine).not.toHaveBeenCalled()
  })

  it('clamps a distance larger than the rebuilt buffer', () => {
    const { terminal, scrollToLine } = pane(5, 0)

    restoreViewport(terminal, 12)

    expect(scrollToLine).toHaveBeenCalledWith(0)
  })
})

/** A buffer holding `lines`, `rows` tall, its view starting at `viewportY`. */
function textPane(lines: string[], rows: number, viewportY: number) {
  const scrollToBottom = vi.fn()
  const scrollToLine = vi.fn()
  const baseY = Math.max(0, lines.length - rows)
  const terminal = {
    buffer: {
      active: {
        baseY,
        viewportY,
        length: lines.length,
        getLine: (y: number) =>
          y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined,
      },
    },
    scrollToBottom,
    scrollToLine,
  } as unknown as Terminal
  return { terminal, scrollToBottom, scrollToLine }
}

const numbered = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `line${from + i}`)

describe('viewport anchor across a resync', () => {
  it('keeps the line being read when output arrived while the pane was hidden', () => {
    // Reading line50 of 100; 20 lines came while hidden, so the end moved and the text did not.
    const anchor = captureViewportAnchor(textPane(numbered(0, 100), 4, 50).terminal)
    const rebuilt = textPane(numbered(0, 120), 4, 116)

    restoreViewportAnchor(rebuilt.terminal, anchor)

    expect(rebuilt.scrollToLine).toHaveBeenCalledWith(50)
  })

  it('finds the line when the replay dropped the oldest lines', () => {
    const anchor = captureViewportAnchor(textPane(numbered(0, 100), 4, 50).terminal)
    const rebuilt = textPane(numbered(10, 120), 4, 106)

    restoreViewportAnchor(rebuilt.terminal, anchor)

    expect(rebuilt.scrollToLine).toHaveBeenCalledWith(40)
  })

  it('finds the line when a large cut and new output both moved it', () => {
    // 10,000 lines read at line9500; the replay kept line9400 on and gained 20 new lines.
    const anchor = captureViewportAnchor(textPane(numbered(0, 10_000), 4, 9_500).terminal)
    const rebuilt = textPane(numbered(9_400, 10_020), 4, 616)

    restoreViewportAnchor(rebuilt.terminal, anchor)

    expect(rebuilt.scrollToLine).toHaveBeenCalledWith(100)
  })

  it('falls back to the distance when the text is gone', () => {
    const anchor = captureViewportAnchor(textPane(numbered(0, 100), 4, 50).terminal)
    const rebuilt = textPane(numbered(500, 600), 4, 96)

    restoreViewportAnchor(rebuilt.terminal, anchor)

    expect(rebuilt.scrollToLine).toHaveBeenCalledWith(50)
  })

  it('keeps following the output for a reader who was at the end', () => {
    const anchor = captureViewportAnchor(textPane(numbered(0, 100), 4, 96).terminal)
    const rebuilt = textPane(numbered(0, 120), 4, 116)

    restoreViewportAnchor(rebuilt.terminal, anchor)

    expect(rebuilt.scrollToBottom).toHaveBeenCalledTimes(1)
    expect(rebuilt.scrollToLine).not.toHaveBeenCalled()
  })
})
