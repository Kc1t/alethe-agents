import { describe, expect, it, vi } from 'vitest'

import {
  LOADED_TERMINAL_FONT_FAMILY,
  remeasureWhenFontLoads,
  TERMINAL_FONT_FAMILY,
} from './terminalFont'

describe('terminal font', () => {
  it('puts the bundled Nerd Font first', () => {
    expect(TERMINAL_FONT_FAMILY.startsWith('"Caskaydia Cove Nerd Font Mono"')).toBe(true)
    expect(TERMINAL_FONT_FAMILY).not.toContain('Courier New')
  })

  it('makes xterm measure again once a late font arrives', async () => {
    const apply = vi.fn()
    const fonts = { check: vi.fn(() => false), load: vi.fn(async () => [{} as FontFace]) }

    remeasureWhenFontLoads(14, apply, fonts)
    await Promise.resolve()
    await Promise.resolve()

    expect(fonts.load).toHaveBeenCalledWith('14px "Caskaydia Cove Nerd Font Mono"')
    expect(apply).toHaveBeenCalledWith(LOADED_TERMINAL_FONT_FAMILY)
    expect(LOADED_TERMINAL_FONT_FAMILY).not.toBe(TERMINAL_FONT_FAMILY)
  })

  it('leaves a terminal alone when the font was already there, or never loads', async () => {
    const apply = vi.fn()
    remeasureWhenFontLoads(14, apply, { check: () => true, load: vi.fn() })
    remeasureWhenFontLoads(14, apply, { check: () => false, load: async () => [] })
    remeasureWhenFontLoads(14, apply, {
      check: () => false,
      load: () => Promise.reject(new Error('blocked')),
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(apply).not.toHaveBeenCalled()
  })
})
