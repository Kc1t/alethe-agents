/**
 * Remembers the last applied theme and visual style so the startup screen,
 * which renders before `projects.json` hydrates, paints with the user's
 * appearance instead of the default dark theme.
 */
const BOOT_APPEARANCE_KEY = 'alethe:boot-appearance'

interface BootAppearance {
  theme: string
  visualStyle: string
}

const SAFE_TOKEN = /^[a-z0-9-]{1,64}$/i

export function applyBootAppearance(root: HTMLElement = document.documentElement): void {
  try {
    const raw = localStorage.getItem(BOOT_APPEARANCE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<BootAppearance>
    if (typeof saved.theme === 'string' && SAFE_TOKEN.test(saved.theme)) {
      root.dataset.theme = saved.theme
    }
    if (typeof saved.visualStyle === 'string' && SAFE_TOKEN.test(saved.visualStyle)) {
      root.dataset.visualStyle = saved.visualStyle
    }
  } catch {
    /* Storage unavailable or corrupt: keep the defaults from index.html. */
  }
}

export function rememberBootAppearance(appearance: BootAppearance): void {
  try {
    localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify(appearance))
  } catch {
    /* Best effort only. */
  }
}
