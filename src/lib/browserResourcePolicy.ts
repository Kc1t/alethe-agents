import type { BrowserResourceMode } from './types'

export type BrowserMemoryPressure = 'normal' | 'warning' | 'critical'

const HIDDEN_EVICTION_DELAYS: Record<BrowserResourceMode, number | null> = {
  'app-first': 1_000,
  balanced: 30_000,
  'keep-alive': null,
}

/** Returns how long a hidden browser may stay alive before its native webview is released. */
export function browserHiddenEvictionDelay(
  mode: BrowserResourceMode,
  pressure: BrowserMemoryPressure,
): number | null {
  if (pressure !== 'normal') return 0
  return HIDDEN_EVICTION_DELAYS[mode]
}
