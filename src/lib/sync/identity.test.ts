import { describe, expect, it } from 'vitest'

import { createOAuthAttempt, transitionDeviceTrust, validateOAuthCallback } from './identity'

describe('OAuth PKCE identity contract', () => {
  it('creates independent high-entropy state, nonce, and verifier values', async () => {
    const first = await createOAuthAttempt('http://127.0.0.1:49152/oauth/callback', 1_000)
    const second = await createOAuthAttempt('http://127.0.0.1:49152/oauth/callback', 1_000)

    expect(first.state.length).toBeGreaterThanOrEqual(40)
    expect(first.nonce.length).toBeGreaterThanOrEqual(40)
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(80)
    expect(first.codeChallenge).not.toBe(first.codeVerifier)
    expect(first.state).not.toBe(second.state)
    expect(first.codeVerifier).not.toBe(second.codeVerifier)
  })

  it('accepts one exact callback and rejects state, route, expiry, and replay failures', async () => {
    const attempt = await createOAuthAttempt('http://localhost:49152/oauth/callback', 1_000)
    const valid = `http://localhost:49152/oauth/callback?code=once&state=${attempt.state}`

    expect(validateOAuthCallback(valid, attempt, 2_000)).toEqual({
      ok: true,
      code: 'once',
      consumedAt: 2_000,
    })
    expect(validateOAuthCallback(valid, { ...attempt, consumedAt: 2_000 }, 2_001)).toEqual({
      ok: false,
      code: 'replayed',
    })
    expect(validateOAuthCallback(`${valid}x`, attempt, 2_000)).toEqual({
      ok: false,
      code: 'state_mismatch',
    })
    expect(
      validateOAuthCallback(
        `http://localhost:49152/wrong?code=once&state=${attempt.state}`,
        attempt,
        2_000,
      ),
    ).toEqual({ ok: false, code: 'invalid' })
    expect(validateOAuthCallback(valid, attempt, attempt.expiresAt + 1)).toEqual({
      ok: false,
      code: 'expired',
    })
  })

  it('rejects non-loopback redirects', async () => {
    await expect(createOAuthAttempt('https://attacker.example/callback')).rejects.toThrow(
      'oauth_redirect_must_be_loopback',
    )
  })
})

describe('device trust transitions', () => {
  const pending = {
    protocolVersion: 1 as const,
    deviceId: 'device-a' as never,
    accountId: 'account-a' as never,
    displayName: 'Workstation',
    publicKey: 'public-key',
    publicKeyFingerprint: 'fingerprint',
    trust: 'pending' as const,
    registeredAt: 1_000,
  }

  it('requires verification before trust and makes revocation terminal', () => {
    const trusted = transitionDeviceTrust(pending, 'trusted', 2_000)
    expect(trusted.lastVerifiedAt).toBe(2_000)
    const revoked = transitionDeviceTrust(trusted, 'revoked', 3_000)
    expect(revoked.revokedAt).toBe(3_000)
    expect(() => transitionDeviceTrust(revoked, 'trusted', 4_000)).toThrow('device_revoked')
  })
})
