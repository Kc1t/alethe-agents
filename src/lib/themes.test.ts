import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { THEME_PACK_MANIFEST } from '../plugins/theme-pack/manifest'
import { THEME_PACK_THEMES } from '../plugins/theme-pack/themes'
import { en } from './i18n/messages/en'
import { BUILTIN_THEME_OPTIONS } from './themes'
import { sanitizeThemeTokens } from './themeTokens'

const css = readFileSync(join(process.cwd(), 'src/styles/theme.css'), 'utf8')
const cssThemeIds = new Set([...css.matchAll(/data-theme='([^']+)'/g)].map((match) => match[1]!))
const builtinIds = BUILTIN_THEME_OPTIONS.map((option) => option.id)
const packIds = THEME_PACK_THEMES.map((theme) => theme.id)

describe('built-in theme definitions stay in sync', () => {
  it('theme ids are unique', () => {
    expect(new Set(builtinIds).size).toBe(builtinIds.length)
  })

  it('every built-in theme has a CSS block, and every CSS block is a built-in', () => {
    expect([...cssThemeIds].sort()).toEqual([...builtinIds].sort())
  })

  it('every built-in theme has English label and description keys', () => {
    for (const id of builtinIds) {
      expect(en[`theme.${id}.label`], `missing label for ${id}`).toBeDefined()
      expect(en[`theme.${id}.desc`], `missing description for ${id}`).toBeDefined()
    }
  })

  it('every swatch color is a valid hex string', () => {
    for (const option of BUILTIN_THEME_OPTIONS) {
      expect(option.colors).toHaveLength(3)
      for (const color of option.colors) {
        expect(color, `invalid color for ${option.id}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    }
  })
})

describe('bundled theme pack', () => {
  it('declares the capability its contributions need', () => {
    expect(THEME_PACK_MANIFEST.capabilities).toContain('ui.theme')
    expect(THEME_PACK_MANIFEST.apiVersion).toBe(1)
  })

  it('does not collide with a built-in id', () => {
    for (const id of packIds) expect(builtinIds).not.toContain(id)
    expect(new Set(packIds).size).toBe(packIds.length)
  })

  it('no longer ships a CSS block in the core stylesheet', () => {
    for (const id of packIds) expect(cssThemeIds).not.toContain(id)
  })

  it('keeps its localized label and description keys in core i18n', () => {
    for (const id of packIds) {
      expect(en[`theme.${id}.label`], `missing label for ${id}`).toBeDefined()
      expect(en[`theme.${id}.desc`], `missing description for ${id}`).toBeDefined()
    }
  })

  it('survives token sanitization with every token intact', () => {
    for (const theme of THEME_PACK_THEMES) {
      const sanitized = sanitizeThemeTokens(theme.tokens)
      expect(Object.keys(sanitized).sort(), `dropped tokens in ${theme.id}`).toEqual(
        Object.keys(theme.tokens).sort(),
      )
    }
  })

  it('carries a background token and a valid swatch', () => {
    for (const theme of THEME_PACK_THEMES) {
      expect(theme.tokens['--bg'], `missing --bg in ${theme.id}`).toBeDefined()
      expect(theme.swatch).toHaveLength(3)
      for (const color of theme.swatch) expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})
