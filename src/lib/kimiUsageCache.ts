import { getKimiUsage } from './tauri'
import { makeTtlCache } from './ttlCache'

export const getCachedKimiUsage = makeTtlCache(getKimiUsage, 60_000)
