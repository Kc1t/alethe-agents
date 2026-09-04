// Opaque account-routing identifier derivation (ADR-0004). Computed entirely locally from an
// already-verified Google account ID; never transmitted for this purpose. Must stay byte-for-byte
// compatible with `account_route_id` in `src-tauri/src/sync_protocol.rs`.

const ACCOUNT_ROUTE_DOMAIN_PREFIX = 'alethe-account-route-v1'

export async function computeAccountRouteId(accountId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ACCOUNT_ROUTE_DOMAIN_PREFIX}${accountId}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
