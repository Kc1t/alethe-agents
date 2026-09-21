import { skillsScan, type SkillAgentSnapshot } from './tauri'

const CACHE_TTL_MS = 10_000

let cached: { value: SkillAgentSnapshot[]; loadedAt: number } | null = null
let inFlight: Promise<SkillAgentSnapshot[]> | null = null

/** Shares short-lived skill scans between the panel and modal to avoid repeated filesystem walks. */
export function scanSkills(force = false): Promise<SkillAgentSnapshot[]> {
  if (!force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.value)
  }
  if (inFlight) return inFlight

  inFlight = skillsScan()
    .then((value) => {
      cached = { value, loadedAt: Date.now() }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
