export const RENDEZVOUS_PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 24 * 1024
export const MAX_CIPHERTEXT_BYTES = 16 * 1024
export const MAX_MAILBOX_ITEMS = 128
export const MAX_MAILBOX_BYTES = 512 * 1024
export const MAX_DEVICE_SOCKETS = 2
export const MAX_ACCOUNT_SOCKETS = 32
export const MAX_AUTH_FAILURES_PER_WINDOW = 8
export const AUTH_WINDOW_MS = 60_000
export const MAX_CONNECTIONS_PER_IP_WINDOW = 40
export const MAX_DEVICE_FRAMES_PER_WINDOW = 120
export const MAX_DEVICE_BYTES_PER_WINDOW = 256 * 1024
export const CHALLENGE_TTL_MS = 30_000
export const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_CANDIDATE_TTL_MS = 5 * 60 * 1_000
export const MAX_PRESENCE_TTL_MS = 2 * 60 * 1_000

const OPAQUE_ROUTE = /^[a-f0-9]{64}$/u
const OPAQUE_ID = /^[a-zA-Z0-9_-]{8,96}$/u
const BASE64URL = /^[a-zA-Z0-9_-]+$/u

export type EnvelopeKind = 'invitation' | 'candidate' | 'revocation'

export type AuthFrame = {
  type: 'auth'
  protocolVersion: 1
  accountRoute: string
  deviceId: string
  publicKey: string
  agreementPublicKey: string
  agreementBoundAtMs: number
  agreementBindingSignature: string
  keyGeneration: number
  challenge: string
  signature: string
}

export type EnqueueFrame = {
  type: 'enqueue'
  id: string
  kind: EnvelopeKind
  recipientAccountRoute: string
  recipientDeviceId?: string
  expiresAtMs: number
  authorizationGeneration: number
  ciphertext: string
}

export type PresenceFrame = {
  type: 'presence'
  generation: number
  expiresAtMs: number
}

export type AckFrame = { type: 'ack'; id: string }
export type PullFrame = { type: 'pull' }
export type DiscoverFrame = { type: 'discover' }
export type ClientFrame =
  AuthFrame | EnqueueFrame | PresenceFrame | AckFrame | PullFrame | DiscoverFrame

export class ProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError('invalid_frame')
  return value as Record<string, unknown>
}

function stringField(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new ProtocolError(code)
  return value
}

function integerField(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolError(code)
  return value as number
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ProtocolError('unknown_field')
}

export function parseClientFrame(raw: string | ArrayBuffer, nowMs: number): ClientFrame {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw)
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new ProtocolError('frame_too_large')
  let value: Record<string, unknown>
  try {
    value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw new ProtocolError('invalid_json')
  }

  switch (value.type) {
    case 'auth': {
      onlyKeys(value, [
        'type',
        'protocolVersion',
        'accountRoute',
        'deviceId',
        'publicKey',
        'agreementPublicKey',
        'agreementBoundAtMs',
        'agreementBindingSignature',
        'keyGeneration',
        'challenge',
        'signature',
      ])
      if (value.protocolVersion !== RENDEZVOUS_PROTOCOL_VERSION)
        throw new ProtocolError('protocol_incompatible')
      return {
        type: 'auth',
        protocolVersion: 1,
        accountRoute: stringField(value.accountRoute, OPAQUE_ROUTE, 'invalid_account_route'),
        deviceId: stringField(value.deviceId, OPAQUE_ID, 'invalid_device_id'),
        publicKey: stringField(value.publicKey, BASE64URL, 'invalid_public_key'),
        agreementPublicKey: stringField(
          value.agreementPublicKey,
          BASE64URL,
          'invalid_agreement_public_key',
        ),
        agreementBoundAtMs: integerField(value.agreementBoundAtMs, 'invalid_agreement_binding'),
        agreementBindingSignature: stringField(
          value.agreementBindingSignature,
          BASE64URL,
          'invalid_agreement_binding',
        ),
        keyGeneration: integerField(value.keyGeneration, 'invalid_key_generation'),
        challenge: stringField(value.challenge, OPAQUE_ID, 'invalid_challenge'),
        signature: stringField(value.signature, BASE64URL, 'invalid_signature'),
      }
    }
    case 'enqueue': {
      onlyKeys(value, [
        'type',
        'id',
        'kind',
        'recipientAccountRoute',
        'recipientDeviceId',
        'expiresAtMs',
        'authorizationGeneration',
        'ciphertext',
      ])
      const kind = value.kind
      if (kind !== 'invitation' && kind !== 'candidate' && kind !== 'revocation') {
        throw new ProtocolError('invalid_envelope_kind')
      }
      const expiresAtMs = integerField(value.expiresAtMs, 'invalid_expiry')
      const maxTtl = kind === 'candidate' ? MAX_CANDIDATE_TTL_MS : MAX_ENVELOPE_TTL_MS
      if (expiresAtMs <= nowMs || expiresAtMs - nowMs > maxTtl)
        throw new ProtocolError('invalid_expiry')
      const ciphertext = stringField(value.ciphertext, BASE64URL, 'invalid_ciphertext')
      if (ciphertext.length > Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4) {
        throw new ProtocolError('ciphertext_too_large')
      }
      return {
        type: 'enqueue',
        id: stringField(value.id, OPAQUE_ID, 'invalid_message_id'),
        kind,
        recipientAccountRoute: stringField(
          value.recipientAccountRoute,
          OPAQUE_ROUTE,
          'invalid_account_route',
        ),
        recipientDeviceId:
          value.recipientDeviceId === undefined
            ? undefined
            : stringField(value.recipientDeviceId, OPAQUE_ID, 'invalid_device_id'),
        expiresAtMs,
        authorizationGeneration: integerField(
          value.authorizationGeneration,
          'invalid_authorization_generation',
        ),
        ciphertext,
      }
    }
    case 'presence': {
      onlyKeys(value, ['type', 'generation', 'expiresAtMs'])
      const expiresAtMs = integerField(value.expiresAtMs, 'invalid_expiry')
      if (expiresAtMs <= nowMs || expiresAtMs - nowMs > MAX_PRESENCE_TTL_MS) {
        throw new ProtocolError('invalid_expiry')
      }
      return {
        type: 'presence',
        generation: integerField(value.generation, 'invalid_generation'),
        expiresAtMs,
      }
    }
    case 'ack':
      onlyKeys(value, ['type', 'id'])
      return { type: 'ack', id: stringField(value.id, OPAQUE_ID, 'invalid_message_id') }
    case 'pull':
      onlyKeys(value, ['type'])
      return { type: 'pull' }
    case 'discover':
      onlyKeys(value, ['type'])
      return { type: 'discover' }
    default:
      throw new ProtocolError('unknown_frame_type')
  }
}

export function authMessage(frame: AuthFrame): Uint8Array {
  return new TextEncoder().encode(
    [
      'alethe-rendezvous-auth-v1',
      frame.accountRoute,
      frame.deviceId,
      String(frame.keyGeneration),
      frame.challenge,
      String(frame.protocolVersion),
    ].join('\n'),
  )
}

export function agreementBindingMessage(frame: AuthFrame): Uint8Array {
  const device = new TextEncoder().encode(frame.deviceId)
  const identity = decodeBase64Url(frame.publicKey)
  const agreement = decodeBase64Url(frame.agreementPublicKey)
  if (identity.byteLength !== 32 || agreement.byteLength !== 32)
    throw new ProtocolError('invalid_agreement_binding')
  const output = new Uint8Array(4 + device.byteLength + 32 + 32 + 8)
  const view = new DataView(output.buffer)
  view.setUint32(0, device.byteLength, true)
  output.set(device, 4)
  output.set(identity, 4 + device.byteLength)
  output.set(agreement, 4 + device.byteLength + 32)
  view.setBigUint64(4 + device.byteLength + 64, BigInt(frame.agreementBoundAtMs), true)
  return output
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded =
    value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function sanitizedError(code: string): string {
  const safe = /^[a-z_]{3,48}$/u.test(code) ? code : 'provider_error'
  return JSON.stringify({ type: 'error', code: safe })
}
