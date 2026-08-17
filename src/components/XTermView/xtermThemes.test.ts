import { describe, expect, it } from 'vitest'

import { getMinimumContrastRatio, getXtermTheme, isLightTerminalTheme } from './xtermThemes'

/** sRGB channel (0..255) → linear light. */
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

/** WCAG 2.1 contrast ratio between two colors, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// The white/brightWhite slots are intentionally light so `\x1b[47m` /
// `\x1b[107m` painted backgrounds still read as backgrounds; the 4.5 render
// floor handles their text role. Every other slot must pass AA directly.
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
] as const
const BACKGROUND_ROLE_SLOTS = ['white', 'brightWhite'] as const

describe('light terminal palettes', () => {
  it('every non-background ANSI slot meets WCAG AA (>= 4.5:1) on light', () => {
    const theme = getXtermTheme('light')
    for (const slot of ANSI_SLOTS) {
      expect(
        contrast(theme[slot], theme.background),
        `${slot} (${theme[slot]})`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('every non-background ANSI slot meets WCAG AA (>= 4.5:1) on min-light', () => {
    const theme = getXtermTheme('min-light')
    for (const slot of ANSI_SLOTS) {
      expect(
        contrast(theme[slot], theme.background),
        `${slot} (${theme[slot]})`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps white/brightWhite light so they still work as painted backgrounds', () => {
    // They cannot be dark (as foreground) and light (as `\x1b[47m` background)
    // at once; the render-time floor covers their text role. Assert they stay
    // close to the background rather than flipping to near-black.
    for (const themeName of ['light', 'min-light'] as const) {
      const theme = getXtermTheme(themeName)
      for (const slot of BACKGROUND_ROLE_SLOTS) {
        expect(luminance(theme[slot]), `${themeName}.${slot}`).toBeGreaterThan(0.6)
      }
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
    // The light-theme fix must not silently alter deliberate dark choices
    // (e.g. Dracula's brightBlack at 2.6:1). Pin the exact slot values.
    const originals = {
      dracula: { brightBlack: '#6272a4', yellow: '#f1fa8c' },
      vscode: { black: '#000000', brightWhite: '#e5e5e5' },
      'min-dark': { brightWhite: '#fafafa', yellow: '#ff9800' },
      'dark-lemon': { brightWhite: '#ffffff', brightBlack: '#5a5a5a' },
      ember: { brightWhite: '#ffffff', green: '#8fbf7f' },
    } as const
    for (const [themeName, pinned] of Object.entries(originals)) {
      const theme = getXtermTheme(themeName as keyof typeof originals)
      for (const [slot, hex] of Object.entries(pinned)) {
        expect(theme[slot as keyof typeof theme], `${themeName}.${slot}`).toBe(hex)
      }
    }
  })
})

describe('isLightTerminalTheme / getMinimumContrastRatio', () => {
  it('applies the 4.5 floor only to the two light themes', () => {
    expect(isLightTerminalTheme('light')).toBe(true)
    expect(isLightTerminalTheme('min-light')).toBe(true)
    expect(getMinimumContrastRatio('light')).toBe(4.5)
    expect(getMinimumContrastRatio('min-light')).toBe(4.5)
  })

  it('leaves dark themes at xterm\u2019s default (undefined)', () => {
    for (const themeName of [
      'dark',
      'dracula',
      'nord',
      'gruvbox',
      'solarized',
      'tokyo-night',
      'vscode',
      'min-dark',
      'dark-lemon',
      'ember',
    ] as const) {
      expect(isLightTerminalTheme(themeName), themeName).toBe(false)
      expect(getMinimumContrastRatio(themeName), themeName).toBeUndefined()
    }
  })
})
