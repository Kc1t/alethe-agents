import { getLocale, translate, type MessageKey, type TFunction } from './i18n'
import type { Theme } from './types'

export type ThemeOption = {
  id: Theme
  colors: [string, string, string]
}

export const THEME_OPTIONS: ThemeOption[] = [
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
  { id: 'dark-lemon', colors: ['#141414', '#ffff50', '#c792ea'] },
  { id: 'orca', colors: ['#0b0b0b', '#181818', '#22c55e'] },
  { id: 'ember', colors: ['#0b0d0e', '#232a2f', '#e0873f'] },
  { id: 'golden-premium', colors: ['#1c1815', '#28211c', '#d4af37'] },
]

export function isLightTheme(id: Theme): boolean {
  const option = THEME_OPTIONS.find((theme) => theme.id === id)
  if (!option) return false
  const hex = option.colors[0].replace('#', '')
  const channel = (start: number) => parseInt(hex.slice(start, start + 2), 16) / 255
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  return luminance > 0.5
}

/** Label localizado do tema (uso em componentes React, via `t`). */
export function themeLabel(t: TFunction, id: Theme): string {
  return t(`theme.${id}.label` as MessageKey)
}

                                                                        
export function themeDescription(t: TFunction, id: Theme): string {
  return t(`theme.${id}.desc` as MessageKey)
}

                                                                           
export function getThemeLabel(id: Theme): string {
  return translate(getLocale(), `theme.${id}.label` as MessageKey)
}
