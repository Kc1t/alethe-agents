/** Shared projects-store constants and clamps. */

const MIN_UI_ZOOM = 0.8
const MAX_UI_ZOOM = 1.4
const UI_ZOOM_STEP = 0.1

export const MAX_RECENT_PROJECT_TABS = 10

export function clampUiZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  const stepped = Math.round(zoom / UI_ZOOM_STEP) * UI_ZOOM_STEP
  const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, stepped))
  return Number(clamped.toFixed(2))
}

export const UI_ZOOM_LIMITS = {
  min: MIN_UI_ZOOM,
  max: MAX_UI_ZOOM,
  step: UI_ZOOM_STEP,
} as const

export const SPAWN_CONCURRENCY_LIMITS = { min: 1, max: 8, step: 1 } as const

export const RESOURCE_MEMORY_BUDGET_LIMITS = { min: 768, max: 32_768, step: 128 } as const

export function clampResourceMemoryBudget(n: number): number {
  if (!Number.isFinite(n)) return 1536
  return Math.min(
    RESOURCE_MEMORY_BUDGET_LIMITS.max,
    Math.max(RESOURCE_MEMORY_BUDGET_LIMITS.min, Math.round(n)),
  )
}

export function clampSpawnConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(
    SPAWN_CONCURRENCY_LIMITS.max,
    Math.max(SPAWN_CONCURRENCY_LIMITS.min, Math.round(n)),
  )
}
