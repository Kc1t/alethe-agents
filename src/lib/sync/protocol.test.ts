import { describe, expect, it } from 'vitest'

import {
  bytesToHex,
  canonicalSignableBytes,
  EnvelopeEncodingError,
  MAX_FIELD_BYTES,
  type SignableEnvelope,
  validateEnvelopeEnvelope,
} from './protocol'

const fixedEnvelope: SignableEnvelope = {
  protocolVersion: 1,
  schemaVersion: 1,
  messageType: 'invitation.notify',
  senderAccountRoute: 'route-sender',
  senderDeviceId: 'dev-sender',
  recipientAccountRoute: 'route-recipient',
  recipientDeviceId: 'dev-recipient',
  messageId: 'msg-1',
  issuedAtMs: 1_000,
  expiresAtMs: 10_000,
  sequence: 1,
  payload: new TextEncoder().encode('payload-bytes'),
  signingKeyId: 'dev-sender',
}

describe('canonicalSignableBytes', () => {
  it('matches the fixed cross-language vector asserted by sync_protocol.rs', () => {
    // Same envelope and expected hex asserted by
    // `sync_protocol::tests::canonical_signable_bytes_match_the_fixed_cross_language_vector`,
    // independently computed field-by-field.
    const hex = bytesToHex(canonicalSignableBytes(fixedEnvelope))
    expect(hex).toBe(
      '010000000100000011000000696e7669746174696f6e2e6e6f746966790c000000726f7574652d73656e6465720a0000006465762d73656e646572010f000000726f7574652d726563697069656e74010d0000006465762d726563697069656e74050000006d73672d31e80300000000000010270000000000000101000000000000000d0000007061796c6f61642d62797465730a0000006465762d73656e646572',
    )
  })

  it('encodes absent optional fields with a zero flag byte', () => {
    const withoutRecipient: SignableEnvelope = {
      ...fixedEnvelope,
      recipientAccountRoute: undefined,
      recipientDeviceId: undefined,
      sequence: undefined,
    }
    const bytes = canonicalSignableBytes(withoutRecipient)
    const withRecipientBytes = canonicalSignableBytes(fixedEnvelope)
    expect(bytes.length).toBeLessThan(withRecipientBytes.length)
  })

  it('rejects a field larger than MAX_FIELD_BYTES before building the buffer', () => {
    const oversized: SignableEnvelope = {
      ...fixedEnvelope,
      messageType: 'x'.repeat(MAX_FIELD_BYTES + 1),
    }
    expect(() => canonicalSignableBytes(oversized)).toThrow(EnvelopeEncodingError)
  })
})

describe('validateEnvelopeEnvelope', () => {
  it('accepts a well-formed, unexpired envelope', () => {
    expect(validateEnvelopeEnvelope(fixedEnvelope, 5_000)).toEqual({ valid: true })
  })

  it('rejects unsupported protocol/schema versions', () => {
    expect(validateEnvelopeEnvelope({ ...fixedEnvelope, protocolVersion: 2 }, 5_000)).toEqual({
      valid: false,
      reason: 'envelope_protocol_unsupported',
    })
    expect(validateEnvelopeEnvelope({ ...fixedEnvelope, schemaVersion: 2 }, 5_000)).toEqual({
      valid: false,
      reason: 'envelope_schema_unsupported',
    })
  })

  it('rejects expired and future-issued envelopes', () => {
    expect(validateEnvelopeEnvelope(fixedEnvelope, 11_000)).toEqual({
      valid: false,
      reason: 'envelope_expired',
    })
    expect(validateEnvelopeEnvelope(fixedEnvelope, 0)).toEqual({
      valid: false,
      reason: 'envelope_issued_in_future',
    })
  })
})
