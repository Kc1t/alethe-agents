export type WslUncPath = {
  distro: string
  linuxPath: string
}

/** Mirror of `parse_wsl_unc` in `src-tauri/src/wsl.rs` — keep both in sync. */
function parseWslUncPath(path: string): WslUncPath | null {
  const normalized = path.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('//')) return null

  const segments = normalized.slice(2).split('/').filter(Boolean)
  const host = segments[0]?.toLowerCase()
  if (host !== 'wsl.localhost' && host !== 'wsl$') return null

  const distro = segments[1]
  if (!distro) return null

  const tail = segments.slice(2)
  return { distro, linuxPath: tail.length ? `/${tail.join('/')}` : '/' }
}

/** Root UNC path of a distro — the fallback when its home directory cannot be probed. */
export function wslDistroRootUnc(distro: string): string | null {
  const trimmed = distro.trim()
  return trimmed ? `\\\\wsl.localhost\\${trimmed}` : null
}

export function toWslGuestPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/')
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`
  return parseWslUncPath(path)?.linuxPath ?? null
}

export function wslTargetFor(cwd: string | null | undefined, enabled: boolean): WslUncPath | null {
  if (!enabled) return null
  return parseWslUncPath(cwd ?? '')
}
