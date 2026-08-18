import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { en } from './i18n/messages/en'
import { THEME_OPTIONS } from './themes'

const css = readFileSync(join(process.cwd(), 'src/styles/theme.css'), 'utf8')
const cssThemeIds = new Set([...css.matchAll(/data-theme='([^']+)'/g)].map((match) => match[1]!))
const themeIds = THEME_OPTIONS.map((option) => option.id)

describe('theme definitions stay in sync', () => {
  it('theme ids are unique', () => {
    expect(new Set(themeIds).size).toBe(themeIds.length)
  })

  it('every picker theme has a CSS block', () => {
    for (const id of themeIds) {
      expect(cssThemeIds, `missing CSS block for ${id}`).toContain(id)
    }
  })

  it('every CSS block appears in the picker', () => {
    expect([...cssThemeIds].sort()).toEqual([...new Set(themeIds)].sort())
  })

  it('every picker theme has English label and description keys', () => {
    for (const id of themeIds) {
      expect(en[`theme.${id}.label`], `missing label for ${id}`).toBeDefined()
      expect(en[`theme.${id}.desc`], `missing description for ${id}`).toBeDefined()
    }
  })

  it('every swatch color is a valid hex string', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.colors).toHaveLength(3)
      for (const color of option.colors) {
        expect(color, `invalid color for ${option.id}`).toMatch(/^#[0-9a-fA-F]{6}$/)
      }
    }
  })
})
