import type { Theme } from '../../lib/types'
import type { FileLinkKind } from './terminalLinks'

/** Estado do menu de ações de link, ancorado no ponto do clique. */
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
const LIGHT_THEME = {
  background: '#fafafa',
  foreground: '#18181b',
  cursor: '#18181b',
  selectionBackground: '#3b82f655',
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
  yellow: '#ff9800',
  blue: '#1976d2',
  magenta: '#6f42c1',
  cyan: '#2b5581',
  white: '#e0e0e0',
  brightBlack: '#757575',
  brightRed: '#d32f2f',
  brightGreen: '#22863a',
  brightYellow: '#ff9800',
  brightBlue: '#1976d2',
  brightMagenta: '#6f42c1',
  brightCyan: '#2b5581',
  brightWhite: '#ffffff',
} as const

export function getXtermTheme(theme: Theme) {
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
