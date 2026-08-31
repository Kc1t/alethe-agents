export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /Macintosh|Mac OS X/i.test(ua)
}

export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Windows/i.test(navigator.userAgent)
}

export function isLinux(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Linux/i.test(navigator.userAgent) && !isAndroid()
}

function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android/i.test(navigator.userAgent)
}

/** Ghostty native terminal is opt-in and macOS-only. */
export function shouldUseNativeBackend(
  nativeTerminalMacos: boolean | undefined,
  macOverride: boolean = isMacOS(),
): boolean {
  return Boolean(nativeTerminalMacos) && macOverride
}

/** Normalize a cwd for equality checks (drive letter / verbatim prefixes on Windows). */
export function normalizeCwd(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const unprefixed = trimmed.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  if (/^[a-z]:/i.test(unprefixed)) return unprefixed.replace(/\//g, '\\').toLowerCase()
  return unprefixed
}

export function formatShortcut(shortcut: string, mac: boolean = isMacOS()): string {
  if (!mac) return shortcut
  return shortcut
    .replace(/Ctrl\+/gi, '⌘')
    .replace(/Shift\+/gi, '⇧')
    .replace(/Alt\+/gi, '⌥')
}
