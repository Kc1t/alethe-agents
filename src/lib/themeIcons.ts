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
  'elite-original': 'elite-original.png',
  'elite-pure-black': 'elite-pure-black.png',
  'elite-indigo': 'elite-indigo.png',
  'elite-blush': 'elite-blush.png',
}

export const APP_ICON_OPTIONS: { id: AppIconTheme; label: string }[] = [
  { id: 'elite-original', label: 'Elite Original' },
  { id: 'elite-pure-black', label: 'Elite Pure Black' },
  { id: 'elite-indigo', label: 'Elite Indigo' },
  { id: 'elite-blush', label: 'Elite Blush' },
]

export function normalizeAppIconTheme(value: unknown): AppIconTheme {
  return typeof value === 'string' && value in ICON_FILES
    ? (value as AppIconTheme)
    : 'elite-indigo'
}

function preferredSize(): number {
  const target = 32 * (globalThis.devicePixelRatio || 1)
  return ICON_SIZES.find((size) => size >= target) ?? ICON_SIZES[ICON_SIZES.length - 1]
}

export function getThemeIcon(theme: AppIconTheme, size = preferredSize()): string {
  const file = ICON_FILES[theme] ?? ICON_FILES['elite-indigo']
  return ICON_URLS[`../assets/theme-icons/${size}/${file}`] ?? ''
}

const iconBytesCache = new Map<string, number[]>()

// Tauri reads a string passed to `setIcon` as a filesystem path, and bundled
// assets only exist as HTTP URLs inside the webview — so the PNG has to travel
// as raw bytes.
function decodeBase64DataUrl(url: string): number[] | null {
  const marker = ';base64,'
  const start = url.startsWith('data:') ? url.indexOf(marker) : -1
  if (start === -1) return null
  const binary = atob(url.slice(start + marker.length))
  const bytes = new Array<number>(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function loadThemeIconBytes(theme: AppIconTheme): Promise<number[]> {
  const url = getThemeIcon(theme)
  if (!url) throw new Error(`No app icon asset for theme "${theme}"`)
  const cached = iconBytesCache.get(url)
  if (cached) return cached
  // Small icons are inlined by the bundler as data URLs, and fetch() answers to
  // connect-src, which does not allow data: — so they have to be decoded directly.
  const inlined = decodeBase64DataUrl(url)
  if (inlined) {
    iconBytesCache.set(url, inlined)
    return inlined
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load app icon ${url}: ${response.status}`)
  const bytes = Array.from(new Uint8Array(await response.arrayBuffer()))
  iconBytesCache.set(url, bytes)
  return bytes
}
