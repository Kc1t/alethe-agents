import type { AccountId, DeviceId } from './contracts'

export const OAUTH_ATTEMPT_TTL_MS = 10 * 60_000

export type OAuthAttempt = {
  id: string
  provider: 'google'
  state: string
  nonce: string
  codeVerifier: string
  codeChallenge: string
  redirectUri: string
  createdAt: number
  expiresAt: number
  consumedAt?: number
}

export type OAuthCallbackResult =
  | { ok: true; code: string; consumedAt: number }
  | { ok: false; code: 'expired' | 'replayed' | 'state_mismatch' | 'provider_error' | 'invalid' }

export type AccountIdentity = {
  protocolVersion: 1
  accountId: AccountId
  provider: 'google' | 'email'
  displayName: string
  emailHint?: string
  connectedAt: number
}

export type DeviceIdentity = {
  protocolVersion: 1
  deviceId: DeviceId
  accountId: AccountId
  displayName: string
  publicKey: string
  publicKeyFingerprint: string
  trust: 'pending' | 'trusted' | 'revoked'
  registeredAt: number
  lastVerifiedAt?: number
  revokedAt?: number
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return base64Url(bytes)
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64Url(new Uint8Array(digest))
}

export async function createOAuthAttempt(
  redirectUri: string,
  now = Date.now(),
): Promise<OAuthAttempt> {
  const redirect = new URL(redirectUri)
  if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(redirect.hostname)) {
    throw new Error('oauth_redirect_must_be_loopback')
  }
  const codeVerifier = randomBase64Url(64)
  return {
    id: randomBase64Url(18),
    provider: 'google',
    state: randomBase64Url(32),
    nonce: randomBase64Url(32),
    codeVerifier,
    codeChallenge: await sha256Base64Url(codeVerifier),
    redirectUri: redirect.toString(),
    createdAt: now,
    expiresAt: now + OAUTH_ATTEMPT_TTL_MS,
  }
}

export function validateOAuthCallback(
  callbackUrl: string,
  attempt: OAuthAttempt,
  now = Date.now(),
): OAuthCallbackResult {
  if (attempt.consumedAt) return { ok: false, code: 'replayed' }
  if (now > attempt.expiresAt) return { ok: false, code: 'expired' }

  let callback: URL
  let expected: URL
  try {
    callback = new URL(callbackUrl)
    expected = new URL(attempt.redirectUri)
  } catch {
    return { ok: false, code: 'invalid' }
  }
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) {
    return { ok: false, code: 'invalid' }
  }
  if (callback.searchParams.get('error')) return { ok: false, code: 'provider_error' }
  if (callback.searchParams.get('state') !== attempt.state) {
    return { ok: false, code: 'state_mismatch' }
  }
  const codes = callback.searchParams.getAll('code')
  if (codes.length !== 1 || !codes[0]) return { ok: false, code: 'invalid' }
  return { ok: true, code: codes[0], consumedAt: now }
}

export function transitionDeviceTrust(
  device: DeviceIdentity,
  next: DeviceIdentity['trust'],
  now = Date.now(),
): DeviceIdentity {
  if (device.trust === 'revoked' && next !== 'revoked') throw new Error('device_revoked')
  if (device.trust === 'pending' && next === 'trusted') {
    return { ...device, trust: next, lastVerifiedAt: now }
  }
  if (next === 'revoked') return { ...device, trust: next, revokedAt: device.revokedAt ?? now }
  if (device.trust !== next) throw new Error('invalid_device_trust_transition')
  return device
}
