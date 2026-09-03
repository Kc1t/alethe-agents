import { getLocale, translateDynamic, type MessageKey, type TFunction } from './i18n'
import { themeContributions, useContributions } from './plugins/registry'
import type { ThemeContribution } from './plugins/types'
import type { BuiltinTheme, Theme } from './types'

export type ThemeOption = {
  id: Theme
  colors: [string, string, string]
  /** Absent for built-ins, whose tokens live in `src/styles/theme.css`. */
  contribution?: ThemeContribution
}

export const BUILTIN_THEME_OPTIONS: { id: BuiltinTheme; colors: [string, string, string] }[] = [
  { id: 'elite-original', colors: ['#fbfafd', '#ede8f7', '#6157f0'] },
  { id: 'elite-pure-black', colors: ['#000000', '#171717', '#ffffff'] },
  { id: 'elite-indigo', colors: ['#0c0c0c', '#1c1c2e', '#7d72ff'] },
  { id: 'elite-blush', colors: ['#fff7f2', '#f3e2d6', '#7a4a3a'] },
  { id: 'dark', colors: ['#101114', '#2a2d33', '#f3f4f6'] },
  { id: 'light', colors: ['#f6f7fb', '#ffffff', '#18181b'] },
  { id: 'dracula', colors: ['#282a36', '#bd93f9', '#ff79c6'] },
  { id: 'nord', colors: ['#2e3440', '#88c0d0', '#a3be8c'] },
  { id: 'gruvbox', colors: ['#282828', '#fabd2f', '#b8bb26'] },
  { id: 'solarized', colors: ['#002b36', '#268bd2', '#b58900'] },
  { id: 'tokyo-night', colors: ['#1a1b26', '#7aa2f7', '#bb9af7'] },
  { id: 'vscode', colors: ['#1e1e1e', '#007acc', '#cccccc'] },
  { id: 'min-dark', colors: ['#1f1f1f', '#fafafa', '#888888'] },
  { id: 'min-light', colors: ['#ffffff', '#1976D2', '#6f42c1'] },
]

const BUILTIN_IDS = new Set<string>(BUILTIN_THEME_OPTIONS.map((option) => option.id))

export function isBuiltinTheme(id: Theme): id is BuiltinTheme {
  return BUILTIN_IDS.has(id)
}

function toOption(contribution: ThemeContribution): ThemeOption {
  return { id: contribution.id, colors: contribution.swatch, contribution }
}

/** Built-ins first, then plugin themes in registration order. */
export function themeOptions(): ThemeOption[] {
  return [...BUILTIN_THEME_OPTIONS, ...themeContributions.all().map(toOption)]
}

/** Reactive `themeOptions()` — re-renders when a plugin adds or removes a theme. */
export function useThemeOptions(): ThemeOption[] {
  const contributed = useContributions(themeContributions)
  return [...BUILTIN_THEME_OPTIONS, ...contributed.map(toOption)]
}

export function findThemeOption(id: Theme): ThemeOption | undefined {
  return themeOptions().find((theme) => theme.id === id)
}

/** True when the id resolves to a built-in or to a currently active plugin theme. */
export function isKnownTheme(id: Theme): boolean {
  return isBuiltinTheme(id) || themeContributions.has(id)
}

/**
 * The theme to actually put on `<html>`. A stored plugin theme renders as the
 * fallback until its plugin activates, and the stored preference is untouched
 * so disabling a plugin temporarily never loses the user's choice.
 */
export function resolveAppliedTheme(id: Theme, fallback: BuiltinTheme = 'dark'): Theme {
  return isKnownTheme(id) ? id : fallback
}

/** Reactive `resolveAppliedTheme` — settles once the owning plugin activates. */
export function useAppliedTheme(id: Theme, fallback: BuiltinTheme = 'dark'): Theme {
  useContributions(themeContributions)
  return resolveAppliedTheme(id, fallback)
}

export function isLightTheme(id: Theme): boolean {
  const option = findThemeOption(id)
  if (!option) return false
  if (option.contribution?.light !== undefined) return option.contribution.light
  const hex = option.colors[0].replace('#', '')
  const channel = (start: number) => parseInt(hex.slice(start, start + 2), 16) / 255
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  return luminance > 0.5
}

function localized(key: string, fallback: string): string {
  const resolved = translateDynamic(getLocale(), key)
  return resolved === key ? fallback : resolved
}

/**
 * Localized label, falling back to the label the contribution declares.
 * Third-party themes are named by their author and are not translated.
 */
export function themeLabel(t: TFunction, id: Theme): string {
  const key = `theme.${id}.label`
  const resolved = t(key as MessageKey)
  return resolved === key ? (findThemeOption(id)?.contribution?.label ?? id) : resolved
}

export function themeDescription(t: TFunction, id: Theme): string {
  const key = `theme.${id}.desc`
  const resolved = t(key as MessageKey)
  return resolved === key ? (findThemeOption(id)?.contribution?.description ?? '') : resolved
}

export function getThemeLabel(id: Theme): string {
  return localized(`theme.${id}.label`, findThemeOption(id)?.contribution?.label ?? id)
}
