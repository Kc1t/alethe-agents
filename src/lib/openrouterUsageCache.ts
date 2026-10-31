import { getOpenRouterUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

const TTL_MS = 60_000

export const getCachedOpenRouterUsage = makeTtlCache(getOpenRouterUsage, TTL_MS)
