import type { AppIconTheme } from './types'

// Windows renders the taskbar button from the window icon at 32px scaled by the
// display DPI, and it does not resample the source — the icon has to arrive at
// (or just above) the size the shell asks for. Variants are generated from the
// 220px masters in this folder.
const ICON_SIZES = [32, 48, 64] as const

const ICON_URLS = import.meta.glob('../assets/theme-icons/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const ICON_FILES: Record<AppIconTheme, string> = {
  dark: 'dark.png',
  light: 'light.png',
  dracula: 'dracula.png',
  nord: 'nord.png',
  gruvbox: 'gruvbox.png',
  solarized: 'solarized.png',
  'tokyo-night': 'tokyo-night.png',
  vscode: 'vscode.png',
  'min-dark': 'min-dark.png',
  'min-light': 'min-light.png',
  'dark-lemon': 'dark-lemon.png',
  orca: 'orca.png',
  'alethe-blue-gradient': 'alethe-blue-gradient.png',
  'alethe-pink-gradient': 'alethe-pink-gradient.png',
}

function preferredSize(): number {
  const target = 32 * (globalThis.devicePixelRatio || 1)
  return ICON_SIZES.find((size) => size >= target) ?? ICON_SIZES[ICON_SIZES.length - 1]
}

export function getThemeIcon(theme: AppIconTheme, size = preferredSize()): string {
  const file = ICON_FILES[theme] ?? ICON_FILES.dark
  return ICON_URLS[`../assets/theme-icons/${size}/${file}`] ?? ''
}

const iconBytesCache = new Map<string, number[]>()

// Tauri reads a string passed to `setIcon` as a filesystem path, and bundled
// assets only exist as HTTP URLs inside the webview — so the PNG has to travel
// as raw bytes.
export async function loadThemeIconBytes(theme: AppIconTheme): Promise<number[]> {
  const url = getThemeIcon(theme)
  if (!url) throw new Error(`No app icon asset for theme "${theme}"`)
  const cached = iconBytesCache.get(url)
  if (cached) return cached
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load app icon ${url}: ${response.status}`)
  const bytes = Array.from(new Uint8Array(await response.arrayBuffer()))
  iconBytesCache.set(url, bytes)
  return bytes
}
