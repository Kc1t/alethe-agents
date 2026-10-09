import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { restoreViewport, viewportDistanceFromBottom } from './terminalViewport'

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
