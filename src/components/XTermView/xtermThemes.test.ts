import type { ITheme } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { themeContributions } from '../../lib/plugins/registry'
import type { Disposable, ThemeContribution } from '../../lib/plugins/types'
import { BUILTIN_THEME_OPTIONS, isLightTheme } from '../../lib/themes'
import { THEME_PACK_THEMES } from '../../plugins/theme-pack/themes'
import { getMinimumContrastRatio, getXtermTheme } from './xtermThemes'

function linear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const
const LIGHT_THEMES = BUILTIN_THEME_OPTIONS.filter(({ id }) => isLightTheme(id)).map(({ id }) => id)
const disposables: Disposable[] = []
afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose()
})

describe('light terminal palettes', () => {
  it.each(LIGHT_THEMES)('every ANSI slot meets WCAG AA (>= 4.5:1) on %s', (id) => {
    const theme: ITheme = getXtermTheme(id)
    for (const slot of ANSI_SLOTS) {
      expect(typeof theme[slot], slot).toBe('string')
      expect(contrast(theme[slot]!, theme.background!), id + '.' + slot).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('dark themes that omit ANSI slots keep the minimal four-key shape', () => {
    for (const themeName of ['dark', 'nord', 'gruvbox', 'solarized', 'tokyo-night'] as const) {
      const theme = getXtermTheme(themeName)
      expect(Object.keys(theme).sort(), themeName).toEqual([
        'background',
        'cursor',
        'foreground',
        'selectionBackground',
      ])
    }
  })

  it('dark themes that ship palettes are left byte-for-byte untouched', () => {
    for (const theme of THEME_PACK_THEMES) {
      disposables.push(themeContributions.add('contrast-test', theme))
    }
    const originals = {
      dracula: { brightBlack: '#6272a4', yellow: '#f1fa8c' },
      vscode: { black: '#000000', brightWhite: '#e5e5e5' },
      'min-dark': { brightWhite: '#fafafa', yellow: '#ff9800' },
      'dark-lemon': { brightWhite: '#ffffff', brightBlack: '#5a5a5a' },
      ember: { brightWhite: '#ffffff', green: '#8fbf7f' },
    } as const
    for (const [themeName, pinned] of Object.entries(originals)) {
      const theme: ITheme = getXtermTheme(themeName)
      for (const [slot, hex] of Object.entries(pinned)) {
        expect(theme[slot as keyof ITheme], `${themeName}.${slot}`).toBe(hex)
      }
    }
  })
})

describe('getMinimumContrastRatio', () => {
  it.each(LIGHT_THEMES)('applies the 4.5 floor to light built-in %s', (id) => {
    expect(getMinimumContrastRatio(id)).toBe(4.5)
  })

  it.each(BUILTIN_THEME_OPTIONS.filter(({ id }) => !isLightTheme(id)).map(({ id }) => id))(
    'leaves dark built-in %s at xterm’s default',
    (id) => expect(getMinimumContrastRatio(id)).toBeUndefined(),
  )

  it.each([
    { swatch: '#ffffff', light: undefined, expected: 4.5 },
    { swatch: '#101114', light: undefined, expected: undefined },
    { swatch: '#101114', light: true, expected: 4.5 },
    { swatch: '#ffffff', light: false, expected: undefined },
  ])('honors plugin swatch $swatch and light override $light', ({ swatch, light, expected }) => {
    const theme: ThemeContribution = {
      id: 'contrast-test',
      label: 'Contrast test',
      swatch: [swatch, '#777777', '#18181b'],
      light,
      tokens: {},
      terminal: { cursor: '#123456' },
    }
    disposables.push(themeContributions.add('contrast-test', theme))
    expect(getMinimumContrastRatio(theme.id)).toBe(expected)
    expect(getXtermTheme(theme.id)).toEqual({
      ...getXtermTheme(expected === 4.5 ? 'light' : 'dark'),
      ...theme.terminal,
    })
    if (expected === 4.5) {
      const palette: ITheme = getXtermTheme(theme.id)
      for (const slot of ANSI_SLOTS) {
        expect(contrast(palette[slot]!, palette.background!), slot).toBeGreaterThanOrEqual(4.5)
      }
    }
    disposables.pop()!.dispose()
    expect(getMinimumContrastRatio(theme.id)).toBeUndefined()
    expect(getXtermTheme(theme.id)).toEqual(getXtermTheme('dark'))
  })

  it('keeps unavailable plugin themes on the dark fallback without a contrast floor', () => {
    expect(getMinimumContrastRatio('unavailable-theme')).toBeUndefined()
    expect(getXtermTheme('unavailable-theme')).toEqual(getXtermTheme('dark'))
  })
})
