// Canonical signed control-envelope encoding (Phase 3). Mirrors the byte-for-byte layout defined
// in `src-tauri/src/sync_protocol.rs::canonical_signable_bytes` — field order, length prefixes,
// and integer endianness must match exactly for the shared cross-language test vector to hold.
// This module never contacts a network service; it only encodes/decodes and enforces size limits.

export const PROTOCOL_VERSION = 1
export const ENVELOPE_SCHEMA_VERSION = 1

/** Matches `MAX_ENVELOPE_BYTES` in `sync_protocol.rs`. */
export const MAX_ENVELOPE_BYTES = 64 * 1024
/** Matches `MAX_FIELD_BYTES` in `sync_protocol.rs`. */
export const MAX_FIELD_BYTES = 16 * 1024

export type SignableEnvelope = {
  protocolVersion: number
  schemaVersion: number
  messageType: string
  senderAccountRoute: string
  senderDeviceId: string
  recipientAccountRoute?: string
  recipientDeviceId?: string
  messageId: string
  issuedAtMs: number
  expiresAtMs: number
  sequence?: number
  payload: Uint8Array
  signingKeyId: string
}

export class EnvelopeEncodingError extends Error {
  constructor(code: string) {
    super(code)
    this.name = 'EnvelopeEncodingError'
  }
}

class ByteWriter {
  private chunks: Uint8Array[] = []
  private length = 0

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  u32(value: number): void {
    const buffer = new Uint8Array(4)
    new DataView(buffer.buffer).setUint32(0, value, true)
    this.push(buffer)
  }

  u64(value: number): void {
    const buffer = new Uint8Array(8)
    new DataView(buffer.buffer).setBigUint64(0, BigInt(value), true)
    this.push(buffer)
  }

  lenPrefixed(bytes: Uint8Array): void {
    if (bytes.length > MAX_FIELD_BYTES) throw new EnvelopeEncodingError('envelope_field_too_large')
    this.u32(bytes.length)
    this.push(bytes)
  }

  lenPrefixedStr(value: string): void {
    this.lenPrefixed(new TextEncoder().encode(value))
  }

  optionalStr(value: string | undefined): void {
    if (value === undefined) {
      this.push(new Uint8Array([0]))
      return
    }
    this.push(new Uint8Array([1]))
    this.lenPrefixedStr(value)
  }

  optionalU64(value: number | undefined): void {
    if (value === undefined) {
      this.push(new Uint8Array([0]))
      return
    }
    this.push(new Uint8Array([1]))
    this.u64(value)
  }

  finish(): Uint8Array {
    if (this.length > MAX_ENVELOPE_BYTES) throw new EnvelopeEncodingError('envelope_too_large')
    const result = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
}

/**
 * Encodes every signable field into the deterministic byte sequence the device identity key
 * signs. Must stay byte-identical to the Rust encoder for the same logical envelope.
 */
export function canonicalSignableBytes(envelope: SignableEnvelope): Uint8Array {
  const writer = new ByteWriter()
  writer.u32(envelope.protocolVersion)
  writer.u32(envelope.schemaVersion)
  writer.lenPrefixedStr(envelope.messageType)
  writer.lenPrefixedStr(envelope.senderAccountRoute)
  writer.lenPrefixedStr(envelope.senderDeviceId)
  writer.optionalStr(envelope.recipientAccountRoute)
  writer.optionalStr(envelope.recipientDeviceId)
  writer.lenPrefixedStr(envelope.messageId)
  writer.u64(envelope.issuedAtMs)
  writer.u64(envelope.expiresAtMs)
  writer.optionalU64(envelope.sequence)
  writer.lenPrefixed(envelope.payload)
  writer.lenPrefixedStr(envelope.signingKeyId)
  return writer.finish()
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Structural validation only — no signature verification (that requires Ed25519 verify, done
 * on the Rust side). Rejects unsupported versions and expired/future-issued envelopes so a
 * frontend can fail closed on a malformed or stale message before ever displaying it. */
export function validateEnvelopeEnvelope(
  envelope: SignableEnvelope,
  nowMs: number,
  maxFutureSkewMs = 0,
): { valid: true } | { valid: false; reason: string } {
  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return { valid: false, reason: 'envelope_protocol_unsupported' }
  }
  if (envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    return { valid: false, reason: 'envelope_schema_unsupported' }
  }
  if (envelope.issuedAtMs > nowMs + maxFutureSkewMs) {
    return { valid: false, reason: 'envelope_issued_in_future' }
  }
  if (nowMs > envelope.expiresAtMs) {
    return { valid: false, reason: 'envelope_expired' }
  }
  return { valid: true }
}
