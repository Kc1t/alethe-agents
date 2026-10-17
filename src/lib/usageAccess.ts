import type { UsageProviderId } from './types'

/**
 * The single gate in front of every provider usage read. Reading usage means using the credentials
 * of an installed CLI and contacting its vendor, so each backend call in `tauri/usage.ts` goes
 * through `withUsageAccess` and is refused here unless the loaded profile allows that provider.
 *
 * Everything starts closed: nothing can read before a profile that allows it has been loaded. The
 * projects store mirrors `preferences.usageAccess` into this module.
 */
const granted: Record<UsageProviderId, boolean> = {
  claude: false,
  codex: false,
  antigravity: false,
  kimi: false,
}

export const USAGE_ACCESS_OFF = 'usage_access_off'

export function hasUsageAccess(provider: UsageProviderId): boolean {
  return granted[provider]
}

/** Replaces what is allowed and returns the providers that just lost access. */
export function setUsageAccess(
  next: Partial<Record<UsageProviderId, boolean>> | undefined,
): UsageProviderId[] {
  const revoked: UsageProviderId[] = []
  for (const provider of Object.keys(granted) as UsageProviderId[]) {
    const allowed = next?.[provider] === true
    if (granted[provider] && !allowed) revoked.push(provider)
    granted[provider] = allowed
  }
  return revoked
}

export function isUsageAccessOff(error: unknown): boolean {
  return error === USAGE_ACCESS_OFF
}

/** Runs `read` only while `provider` is allowed, and drops a result that arrives after it was not. */
export async function withUsageAccess<T>(
  provider: UsageProviderId,
  read: () => Promise<T>,
): Promise<T> {
  if (!granted[provider]) throw USAGE_ACCESS_OFF
  const value = await read()
  if (!granted[provider]) throw USAGE_ACCESS_OFF
  return value
}
