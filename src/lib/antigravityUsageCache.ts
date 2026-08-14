import { getAntigravityUsage } from './api/usage'
import { makeTtlCache } from './ttlCache'

const TTL_MS = 60_000

export const getCachedAntigravityUsage = makeTtlCache(getAntigravityUsage, TTL_MS)
