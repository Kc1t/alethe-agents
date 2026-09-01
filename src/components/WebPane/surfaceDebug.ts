import type { SurfaceRect } from '../../lib/surfaceGeometry'

export type SurfaceDebugInfo = {
  css: SurfaceRect | null
  physical: SurfaceRect | null
  ratio: number
  visible: boolean
  intersecting: boolean
  occluded: boolean
  label: string
  failure: string
}

const STORAGE_KEY = 'alethe:surface-debug'

/**
 * Native surface placement can only be judged on the machine that misplaces it, and a screenshot of
 * the running app carries no numbers. Setting `localStorage['alethe:surface-debug'] = '1'` overlays
 * the measurements the driver is actually using.
 */
export function isSurfaceDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function formatSurfaceRect(rect: SurfaceRect | null): string {
  if (!rect) return '—'
  const round = (value: number) => Math.round(value)
  return `${round(rect.width)}×${round(rect.height)} @ ${round(rect.x)},${round(rect.y)}`
}
