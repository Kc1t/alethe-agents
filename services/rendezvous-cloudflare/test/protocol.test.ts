import { describe, expect, it } from 'vitest'

import {
  authMessage,
  MAX_CANDIDATE_TTL_MS,
  MAX_FRAME_BYTES,
  parseClientFrame,
  ProtocolError,
  sanitizedError,
} from '../src/protocol'

const now = 10_000
const route = 'a'.repeat(64)

describe('rendezvous control protocol', () => {
  it('accepts only the bounded provider-visible auth fields', () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: 'auth',
        protocolVersion: 1,
        accountRoute: route,
        deviceId: 'device_opaque_123',
        publicKey: 'A'.repeat(43),
        keyGeneration: 1,
        challenge: 'challenge_opaque_123',
        agreementPublicKey: 'C'.repeat(43),
        agreementBoundAtMs: 9_000,
        agreementBindingSignature: 'D'.repeat(86),
        signature: 'B'.repeat(86),
      }),
      now,
    )
    expect(frame.type).toBe('auth')
    expect(() =>
      parseClientFrame(JSON.stringify({ ...frame, projectName: 'secret' }), now),
    ).toThrowError(new ProtocolError('unknown_field'))
  })

  it('rejects oversized frames and candidate retention', () => {
    expect(() => parseClientFrame('x'.repeat(MAX_FRAME_BYTES + 1), now)).toThrowError(
      new ProtocolError('frame_too_large'),
    )
    expect(() =>
      parseClientFrame(
        JSON.stringify({
          type: 'enqueue',
          id: 'message_opaque_123',
          kind: 'candidate',
          recipientAccountRoute: 'b'.repeat(64),
          expiresAtMs: now + MAX_CANDIDATE_TTL_MS + 1,
          authorizationGeneration: 1,
          ciphertext: 'AQID',
        }),
        now,
      ),
    ).toThrowError(new ProtocolError('invalid_expiry'))
  })

  it('uses a stable challenge binding without secrets or project metadata', () => {
    const message = new TextDecoder().decode(
      authMessage({
        type: 'auth',
        protocolVersion: 1,
        accountRoute: route,
        deviceId: 'device_opaque_123',
        publicKey: 'A'.repeat(43),
        keyGeneration: 7,
        challenge: 'challenge_opaque_123',
        agreementPublicKey: 'C'.repeat(43),
        agreementBoundAtMs: 9_000,
        agreementBindingSignature: 'D'.repeat(86),
        signature: 'B'.repeat(86),
      }),
    )
    expect(message).toBe(
      [
        'alethe-rendezvous-auth-v1',
        route,
        'device_opaque_123',
        '7',
        'challenge_opaque_123',
        '1',
      ].join('\n'),
    )
  })

  it('sanitizes provider errors before returning them', () => {
    expect(sanitizedError('rate_limited')).toBe('{"type":"error","code":"rate_limited"}')
    expect(sanitizedError('secret bearer value')).toBe('{"type":"error","code":"provider_error"}')
  })
})
