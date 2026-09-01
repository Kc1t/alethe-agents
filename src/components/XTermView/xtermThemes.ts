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

// xterm's built-in ANSI palette assumes a dark background: anything a TUI paints
// as white or bright white disappears on a light one. These keep every hue so agent
// branding survives, and only re-point the neutrals that would otherwise vanish.
const LIGHT_ANSI = {
  black: '#1f2328',
  red: '#c0392b',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#3d3d3d',
  brightBlack: '#6e7781',
  brightRed: '#cf222e',
  brightGreen: '#1a7f37',
  brightYellow: '#bf8700',
  brightBlue: '#0969da',
  brightMagenta: '#8250df',
  brightCyan: '#1b7c83',
  brightWhite: '#1f2328',
} as const

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
  ...LIGHT_ANSI,
  white: '#3f3f46',
  brightWhite: '#18181b',
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
  white: '#3d3d3d',
  brightBlack: '#757575',
  brightRed: '#d32f2f',
  brightGreen: '#22863a',
  brightYellow: '#ff9800',
  brightBlue: '#1976d2',
  brightMagenta: '#6f42c1',
  brightCyan: '#2b5581',
  brightWhite: '#212121',
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

const GOLDEN_PREMIUM_THEME = {
  background: '#1c1815',
  foreground: '#f5eedc',
  cursor: '#d4af37',
  selectionBackground: '#2b2320',
  black: '#14110e',
  red: '#ef4444',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#d4af37',
  magenta: '#c084fc',
  cyan: '#38bdf8',
  white: '#f5eedc',
  brightBlack: '#736754',
  brightRed: '#f87171',
  brightGreen: '#86efac',
  brightYellow: '#fef08a',
  brightBlue: '#fde047',
  brightMagenta: '#d8b4fe',
  brightCyan: '#7dd3fc',
  brightWhite: '#ffffff',
} as const

const ORCA_THEME = {
  background: '#0b0b0b',
  foreground: '#f5f5f5',
  cursor: '#e8e8e8',
  selectionBackground: '#ffffff33',
} as const
const ELITE_ORIGINAL_THEME = {
  background: '#fbfafd',
  foreground: '#241c33',
  cursor: '#6157f0',
  selectionBackground: '#6157f033',
  ...LIGHT_ANSI,
  white: '#4a4160',
  brightWhite: '#241c33',
} as const
const ELITE_PURE_BLACK_THEME = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  selectionBackground: '#ffffff33',
} as const
const ELITE_INDIGO_THEME = {
  background: '#0c0c0c',
  foreground: '#f2f0ff',
  cursor: '#7d72ff',
  selectionBackground: '#7d72ff44',
} as const
const ELITE_BLUSH_THEME = {
  background: '#fff7f2',
  foreground: '#3b2a22',
  cursor: '#7a4a3a',
  selectionBackground: '#7a4a3a33',
  ...LIGHT_ANSI,
  white: '#5c4438',
  brightWhite: '#3b2a22',
} as const

const XTERM_THEMES = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  dracula: DRACULA_THEME,
  nord: NORD_THEME,
  gruvbox: GRUVBOX_THEME,
  solarized: SOLARIZED_THEME,
  'tokyo-night': TOKYO_NIGHT_THEME,
  vscode: VSCODE_THEME,
  'min-dark': MIN_DARK_THEME,
  'min-light': MIN_LIGHT_THEME,
  'dark-lemon': DARK_LEMON_THEME,
  orca: ORCA_THEME,
  ember: EMBER_THEME,
  'golden-premium': GOLDEN_PREMIUM_THEME,
  'elite-original': ELITE_ORIGINAL_THEME,
  'elite-pure-black': ELITE_PURE_BLACK_THEME,
  'elite-indigo': ELITE_INDIGO_THEME,
  'elite-blush': ELITE_BLUSH_THEME,
} satisfies Record<Theme, unknown>

export function getXtermTheme(theme: Theme) {
  return XTERM_THEMES[theme] ?? DARK_THEME
}
