import { describe, expect, it } from 'vitest'

import { collectTerminalContextText } from './terminalContextMenu'

function makeBuffer(lines: string[]) {
  return {
    length: lines.length,
    getLine: (index: number) =>
      index >= 0 && index < lines.length
        ? { translateToString: () => lines[index] }
        : undefined,
  }
}

describe('collectTerminalContextText', () => {
  it('prefers the current selection when present', () => {
    const text = collectTerminalContextText({
      hasSelection: () => true,
      getSelection: () => 'selected snippet\n',
      buffer: { active: makeBuffer(['ignored']) },
    })
    expect(text).toBe('selected snippet')
  })

  it('falls back to a bounded trailing buffer transcript', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line-${i}`)
    const text = collectTerminalContextText(
      {
        hasSelection: () => false,
        getSelection: () => '',
        buffer: { active: makeBuffer(lines) },
      },
      3,
    )
    expect(text).toBe('line-2\nline-3\nline-4')
  })
})
