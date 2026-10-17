import { describe, expect, it } from 'vitest'

import { DEFAULT_TERMINAL_FONT_FAMILY } from '../../lib/types'
import {
  remeasuredFontFamily,
  resolveTerminalFontFamily,
  TERMINAL_FONT_FAMILY,
} from './terminalFont'

describe('terminal font', () => {
  it('puts the bundled fonts ahead of any system font', () => {
    expect(
      TERMINAL_FONT_FAMILY.startsWith('"Caskaydia Cove Nerd Font Mono", "Alethe Terminal Symbols"'),
    ).toBe(true)
    expect(TERMINAL_FONT_FAMILY.endsWith('monospace')).toBe(true)
  })

  it('always hands xterm a different value so it re-measures the cell', () => {
    const first = remeasuredFontFamily(TERMINAL_FONT_FAMILY, TERMINAL_FONT_FAMILY)
    expect(first).not.toBe(TERMINAL_FONT_FAMILY)
    expect(first.trim()).toBe(TERMINAL_FONT_FAMILY)
    expect(remeasuredFontFamily(first, TERMINAL_FONT_FAMILY)).toBe(TERMINAL_FONT_FAMILY)
  })

  it('uses the bundled stack until the user picks another font', () => {
    expect(resolveTerminalFontFamily(DEFAULT_TERMINAL_FONT_FAMILY)).toBe(TERMINAL_FONT_FAMILY)
    expect(resolveTerminalFontFamily('  ')).toBe(TERMINAL_FONT_FAMILY)
    expect(resolveTerminalFontFamily('Fira Code')).toBe(`Fira Code, ${TERMINAL_FONT_FAMILY}`)
  })
})
