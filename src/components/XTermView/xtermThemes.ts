import type { Theme } from '../../lib/types'
import type { FileLinkKind } from './terminalLinks'

export type LinkActionState = {
  text: string
  target: string
  kind: 'url' | 'path'
  fileKind?: FileLinkKind
  x: number
  y: number
}

const DARK_THEME = {
  background: '#101114',
  foreground: '#f3f4f6',
  cursor: '#f3f4f6',
  selectionBackground: '#3b82f666',
} as const
// A light background inverts the usual rules: xterm.js falls back to the
// dark-oriented Tango palette for any slot we omit, which fails WCAG AA on
// #fafafa. Every slot below therefore ships an explicit color that keeps
// >= 4.5:1 against the background (#97).
//
// The one deliberate exception is white/brightWhite: they serve a dual role
// as both foreground text and painted background (\x1b[47m / \x1b[107m, used
// by `less` status bars). Keeping them light lets a painted background still
// read as a background; the `minimumContrastRatio` floor (4.5, enabled only
// for light themes) darkens them at render time when they are used as text.
const LIGHT_THEME = {
  background: '#fafafa',
  foreground: '#18181b',
  cursor: '#18181b',
  selectionBackground: '#3b82f655',
  black: '#27272a',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#dc2626',
  brightGreen: '#166534',
  brightYellow: '#b45309',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#155e75',
  brightWhite: '#f4f4f5',
} as const
const DRACULA_THEME = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
} as const
const NORD_THEME = {
  background: '#2e3440',
  foreground: '#eceff4',
  cursor: '#eceff4',
  selectionBackground: '#4c566a',
} as const
const GRUVBOX_THEME = {
  background: '#282828',
  foreground: '#fbf1c7',
  cursor: '#fbf1c7',
  selectionBackground: '#665c54',
} as const
const SOLARIZED_THEME = {
  background: '#002b36',
  foreground: '#fdf6e3',
  cursor: '#fdf6e3',
  selectionBackground: '#073642',
} as const
const TOKYO_NIGHT_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#414868',
} as const
const VSCODE_THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
} as const
const MIN_DARK_THEME = {
  background: '#1f1f1f',
  foreground: '#fafafa',
  cursor: '#fafafa',
  selectionBackground: '#383838',
  black: '#1a1a1a',
  red: '#f97583',
  green: '#fafafa',
  yellow: '#ff9800',
  blue: '#d0d0d0',
  magenta: '#bdbdbd',
  cyan: '#9db1c5',
  white: '#bbbbbb',
  brightBlack: '#6b737c',
  brightRed: '#ff7a84',
  brightGreen: '#ffffff',
  brightYellow: '#ffab70',
  brightBlue: '#e0e0e0',
  brightMagenta: '#d0d0d0',
  brightCyan: '#9db1c5',
  brightWhite: '#fafafa',
} as const
const DARK_LEMON_THEME = {
  background: '#141414',
  foreground: '#ffffff',
  cursor: '#ffff50',
  selectionBackground: '#ffff5028',
  black: '#1a1a1a',
  red: '#ff5370',
  green: '#c3e88d',
  yellow: '#ffcb6b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#cfcfcf',
  brightBlack: '#5a5a5a',
  brightRed: '#ff5370',
  brightGreen: '#c3e88d',
  brightYellow: '#ffff50',
  brightBlue: '#82aaff',
  brightMagenta: '#c792ea',
  brightCyan: '#89ddff',
  brightWhite: '#ffffff',
} as const
const MIN_LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#212121',
  cursor: '#212121',
  selectionBackground: '#eeeeee',
  black: '#212121',
  red: '#d32f2f',
  green: '#22863a',
  // #ff9800 (Material orange 500) is 2.16:1 on white; darken the yellow
  // slots to keep the author's amber intent while meeting WCAG AA (#97).
  yellow: '#b45309',
  blue: '#1976d2',
  magenta: '#6f42c1',
  cyan: '#2b5581',
  white: '#e0e0e0',
  brightBlack: '#757575',
  brightRed: '#d32f2f',
  brightGreen: '#22863a',
  brightYellow: '#b45309',
  brightBlue: '#1976d2',
  brightMagenta: '#6f42c1',
  brightCyan: '#2b5581',
  brightWhite: '#ffffff',
} as const

const EMBER_THEME = {
  background: '#0b0d0e',
  foreground: '#dfe3e6',
  cursor: '#e0873f',
  selectionBackground: '#2e363b',
  black: '#191d21',
  red: '#e0605c',
  green: '#8fbf7f',
  yellow: '#d9b44a',
  blue: '#7fa8c9',
  magenta: '#b294bb',
  cyan: '#82b5b5',
  white: '#dfe3e6',
  brightBlack: '#525b61',
  brightRed: '#eb7a76',
  brightGreen: '#a5cf96',
  brightYellow: '#e0873f',
  brightBlue: '#9cc0dc',
  brightMagenta: '#c8aecf',
  brightCyan: '#9bcaca',
  brightWhite: '#ffffff',
} as const

export function getXtermTheme(theme: Theme) {
  if (theme === 'ember') return EMBER_THEME
  if (theme === 'light') return LIGHT_THEME
  if (theme === 'dracula') return DRACULA_THEME
  if (theme === 'nord') return NORD_THEME
  if (theme === 'gruvbox') return GRUVBOX_THEME
  if (theme === 'solarized') return SOLARIZED_THEME
  if (theme === 'tokyo-night') return TOKYO_NIGHT_THEME
  if (theme === 'vscode') return VSCODE_THEME
  if (theme === 'min-dark') return MIN_DARK_THEME
  if (theme === 'min-light') return MIN_LIGHT_THEME
  if (theme === 'dark-lemon') return DARK_LEMON_THEME
  return DARK_THEME
}

/**
 * Whether a theme paints a light terminal background. Only these themes get
 * the render-time contrast floor, so the ten dark themes stay byte-identical.
 */
export function isLightTerminalTheme(theme: Theme): boolean {
  return theme === 'light' || theme === 'min-light'
}

/**
 * xterm's `minimumContrastRatio` for a theme, or `undefined` to keep xterm's
 * default (1). On light backgrounds even a correct palette cannot cover
 * 256-color / truecolor output from agents (e.g. `\x1b[38;5;N`), and the
 * white/brightWhite slots double as painted backgrounds, so we enforce a
 * WCAG-AA floor of 4.5 at render time — the same approach VS Code ships by
 * default. Dark themes are left untouched (#97).
 */
export function getMinimumContrastRatio(theme: Theme): number | undefined {
  return isLightTerminalTheme(theme) ? 4.5 : undefined
}
