import { themeContributions } from './plugins/registry'
import type { ThemeContribution } from './plugins/types'

const STYLE_ELEMENT_ID = 'alethe-plugin-themes'

/** Theme ids become part of an attribute selector, so keep them boring. */
const THEME_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Only custom properties may be written — never a real CSS property. */
const TOKEN_NAME_PATTERN = /^--[a-z][a-z0-9-]*$/

const MAX_TOKEN_VALUE_LENGTH = 240

/**
 * Anything that can reach the network, escape the declaration, or smuggle a
 * second rule. `\` is refused outright so a CSS escape cannot rebuild `url(`.
 */
const FORBIDDEN_VALUE = /url\s*\(|image\s*(-set)?\s*\(|expression\s*\(|javascript:|data:|[@;{}<>\\]|\/\*|\*\//i

/** Colors, lengths, easings and shadow lists all fit inside this charset. */
const ALLOWED_VALUE_CHARS = /^[A-Za-z0-9#%.,()+\-_/\s'"]+$/

export function isValidThemeId(id: string): boolean {
  return THEME_ID_PATTERN.test(id)
}

export function isValidTokenName(name: string): boolean {
  return TOKEN_NAME_PATTERN.test(name)
}

export function isValidTokenValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_TOKEN_VALUE_LENGTH) return false
  if (FORBIDDEN_VALUE.test(trimmed)) return false
  return ALLOWED_VALUE_CHARS.test(trimmed)
}

/**
 * Drops every token that is not a safe custom property assignment. Silent by
 * design: one bad token must not cost a theme its remaining colors.
 */
export function sanitizeThemeTokens(tokens: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [name, rawValue] of Object.entries(tokens)) {
    if (!isValidTokenName(name)) continue
    if (typeof rawValue !== 'string' || !isValidTokenValue(rawValue)) continue
    safe[name] = rawValue.trim()
  }
  return safe
}

export function themeContributionToCss(contribution: ThemeContribution): string {
  if (!isValidThemeId(contribution.id)) return ''
  const tokens = sanitizeThemeTokens(contribution.tokens)
  const entries = Object.entries(tokens)
  if (entries.length === 0) return ''
  const body = entries.map(([name, value]) => `  ${name}: ${value};`).join('\n')
  return `[data-theme='${contribution.id}'] {\n${body}\n}`
}

export function buildPluginThemeCss(contributions: readonly ThemeContribution[]): string {
  return contributions
    .map(themeContributionToCss)
    .filter((block) => block.length > 0)
    .join('\n\n')
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing instanceof HTMLStyleElement) return existing
  const element = document.createElement('style')
  element.id = STYLE_ELEMENT_ID
  document.head.appendChild(element)
  return element
}

export function applyPluginThemeStyles(): void {
  if (typeof document === 'undefined') return
  styleElement().textContent = buildPluginThemeCss(themeContributions.all())
}

/** Keeps the injected stylesheet in step with the registry for the app's life. */
export function watchPluginThemeStyles(): () => void {
  applyPluginThemeStyles()
  return themeContributions.subscribe(applyPluginThemeStyles)
}
