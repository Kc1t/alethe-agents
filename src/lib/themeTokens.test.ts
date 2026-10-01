import { describe, expect, it } from 'vitest'

import type { ThemeContribution } from './plugins/types'
import {
  buildPluginThemeCss,
  isValidThemeId,
  isValidTokenName,
  isValidTokenValue,
  sanitizeThemeTokens,
  themeContributionToCss,
} from './themeTokens'

function contribution(overrides: Partial<ThemeContribution> = {}): ThemeContribution {
  return {
    id: 'sample',
    label: 'Sample',
    swatch: ['#000000', '#ffffff', '#ffffff'],
    tokens: { '--bg': '#101114' },
    ...overrides,
  }
}

describe('isValidThemeId', () => {
  it('accepts lowercase kebab ids', () => {
    expect(isValidThemeId('ember')).toBe(true)
    expect(isValidThemeId('golden-premium')).toBe(true)
  })

  it('rejects anything that could break out of the attribute selector', () => {
    for (const id of ["ever'] * {color:red} [x", 'Ember', 'a b', '-lead', '1st', '']) {
      expect(isValidThemeId(id), id).toBe(false)
    }
  })
})

describe('isValidTokenName', () => {
  it('accepts custom properties only', () => {
    expect(isValidTokenName('--bg')).toBe(true)
    expect(isValidTokenName('--accent-border-soft')).toBe(true)
    expect(isValidTokenName('background')).toBe(false)
    expect(isValidTokenName('--BG')).toBe(false)
    expect(isValidTokenName('--')).toBe(false)
  })
})

describe('isValidTokenValue', () => {
  it('accepts the value shapes real themes use', () => {
    for (const value of [
      '#141414',
      '#ffff5028',
      'rgba(255, 255, 80, 0.1)',
      'rgb(0 0 0 / 50%)',
      'hsl(210, 40%, 12%)',
      '0 12px 32px rgba(0, 0, 0, 0.65)',
      'cubic-bezier(0.2, 0.8, 0.2, 1)',
      '180ms',
      '0',
      'transparent',
      "'Caskaydia Cove', monospace",
    ]) {
      expect(isValidTokenValue(value), value).toBe(true)
    }
  })

  it('rejects network access and rule escapes', () => {
    for (const value of [
      'url(https://evil.test/pixel.png)',
      'URL( https://evil.test )',
      'u\\rl(https://evil.test)',
      'image-set(https://evil.test/a.png)',
      "expression(alert('x'))",
      'red; background: url(https://evil.test)',
      'red } body { background: red',
      '#fff /* comment */',
      '@import "https://evil.test"',
      'data:text/css,x',
      'javascript:alert(1)',
      '',
      '   ',
    ]) {
      expect(isValidTokenValue(value), value).toBe(false)
    }
  })

  it('rejects an absurdly long value', () => {
    expect(isValidTokenValue('#fff '.repeat(100))).toBe(false)
  })
})

describe('sanitizeThemeTokens', () => {
  it('keeps safe tokens and drops unsafe ones', () => {
    const sanitized = sanitizeThemeTokens({
      '--bg': '#101114',
      '--accent': ' #7d72ff ',
      '--evil': 'url(https://evil.test)',
      background: 'red',
      'accent-typo': '#ffffff',
      '--break': 'red; }',
    })
    expect(sanitized).toEqual({ '--bg': '#101114', '--accent': '#7d72ff' })
  })

  it('drops a name without the leading dashes instead of guessing', () => {
    expect(sanitizeThemeTokens({ bg: '#000000' })).toEqual({})
  })
})

describe('themeContributionToCss', () => {
  it('emits one scoped block', () => {
    expect(themeContributionToCss(contribution())).toBe(
      "[data-theme='sample'] {\n  --bg: #101114;\n}",
    )
  })

  it('emits nothing for an unsafe id or an empty token set', () => {
    expect(themeContributionToCss(contribution({ id: 'Bad Id' }))).toBe('')
    expect(themeContributionToCss(contribution({ tokens: {} }))).toBe('')
    expect(themeContributionToCss(contribution({ tokens: { '--x': 'url(a)' } }))).toBe('')
  })

  it('never lets a hostile token reach the stylesheet', () => {
    const css = buildPluginThemeCss([
      contribution({ tokens: { '--bg': '#000000', '--evil': 'red; } * { display: none' } }),
    ])
    expect(css).toContain('--bg: #000000;')
    expect(css).not.toContain('display: none')
    expect(css.match(/\{/g)).toHaveLength(1)
  })

  it('joins several contributions', () => {
    const css = buildPluginThemeCss([
      contribution({ id: 'one' }),
      contribution({ id: 'two', tokens: { '--fg': '#ffffff' } }),
    ])
    expect(css).toContain("[data-theme='one']")
    expect(css).toContain("[data-theme='two']")
  })
})
