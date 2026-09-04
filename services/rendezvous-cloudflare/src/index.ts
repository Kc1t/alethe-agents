import {
  agreementBindingMessage,
  AUTH_WINDOW_MS,
  type AuthFrame,
  authMessage,
  CHALLENGE_TTL_MS,
  decodeBase64Url,
  type EnqueueFrame,
  MAX_ACCOUNT_SOCKETS,
  MAX_AUTH_FAILURES_PER_WINDOW,
  MAX_CONNECTIONS_PER_IP_WINDOW,
  MAX_DEVICE_BYTES_PER_WINDOW,
  MAX_DEVICE_FRAMES_PER_WINDOW,
  MAX_DEVICE_SOCKETS,
  MAX_FRAME_BYTES,
  MAX_MAILBOX_BYTES,
  MAX_MAILBOX_ITEMS,
  parseClientFrame,
  ProtocolError,
  RENDEZVOUS_PROTOCOL_VERSION,
  sanitizedError,
} from './protocol'

export interface Env {
  ACCOUNT_ROUTES: DurableObjectNamespace
  ABUSE_HASH_KEY?: string
}

type SocketAttachment = {
  accountRoute: string
  deviceId?: string
  authenticated: boolean
  challenge: string
  challengeExpiresAtMs: number
  ipSignal: string
  frameWindowStartedAtMs: number
  frameCount: number
  frameBytes: number
}

const MAX_DELIVERY_BATCH = 32

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/v1/info') {
      return json({
        service: 'alethe-rendezvous',
        protocolMin: RENDEZVOUS_PROTOCOL_VERSION,
        protocolMax: RENDEZVOUS_PROTOCOL_VERSION,
        transport: 'websocket',
      })
    }
    if (request.method !== 'GET' || url.pathname !== '/v1/connect')
      return json({ code: 'not_found' }, 404)
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json({ code: 'websocket_required' }, 426)
    }
    const accountRoute = url.searchParams.get('accountRoute') ?? ''
    if (!/^[a-f0-9]{64}$/u.test(accountRoute)) return json({ code: 'invalid_account_route' }, 400)
    const ip =
      request.headers.get('cf-connecting-ip') ??
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' ? 'local-test' : '')
    if (!ip || (!env.ABUSE_HASH_KEY && ip !== 'local-test'))
      return json({ code: 'provider_misconfigured' }, 503)
    const keyMaterial = new TextEncoder().encode(env.ABUSE_HASH_KEY ?? 'local-test-only')
    const key = await crypto.subtle.importKey(
      'raw',
      keyMaterial,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))
    const ipSignal = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const id = env.ACCOUNT_ROUTES.idFromName(accountRoute)
    const headers = new Headers(request.headers)
    headers.set('x-alethe-ip-signal', ipSignal)
    return env.ACCOUNT_ROUTES.get(id).fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>

export class AccountRoute implements DurableObject {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          agreement_public_key TEXT NOT NULL,
          agreement_bound_at_ms INTEGER NOT NULL,
          agreement_binding_signature TEXT NOT NULL,
          key_generation INTEGER NOT NULL,
          revocation_generation INTEGER NOT NULL DEFAULT 0,
          presence_generation INTEGER NOT NULL DEFAULT 0,
          presence_expires_at_ms INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mailbox (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          sender_device_id TEXT NOT NULL,
          recipient_device_id TEXT,
          authorization_generation INTEGER NOT NULL,
          ciphertext TEXT NOT NULL,
          ciphertext_bytes INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mailbox_recipient_expiry
          ON mailbox(recipient_device_id, expires_at_ms);
        CREATE TABLE IF NOT EXISTS auth_limits (
          device_id TEXT PRIMARY KEY,
          window_started_at_ms INTEGER NOT NULL,
          failures INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connection_limits (
          ip_signal TEXT PRIMARY KEY,
          window_started_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL
        );
      `)
    })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === 'POST' && new URL(request.url).pathname === '/internal/enqueue') {
      if (request.headers.get('x-alethe-internal') !== '1') return json({ code: 'not_found' }, 404)
      const raw = await request.text()
      if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES + 256) {
        return json({ code: 'frame_too_large' }, 413)
      }
      try {
        const value = JSON.parse(raw) as { senderDeviceId?: unknown; frame?: unknown }
        if (
          typeof value.senderDeviceId !== 'string' ||
          !/^[a-zA-Z0-9_-]{8,96}$/u.test(value.senderDeviceId)
        ) {
          throw new ProtocolError('invalid_device_id')
        }
        const frame = parseClientFrame(JSON.stringify(value.frame), Date.now())
        if (frame.type !== 'enqueue') throw new ProtocolError('invalid_frame')
        await this.persistEnvelope(value.senderDeviceId, frame)
        return json({ accepted: true })
      } catch (error) {
        return json({ code: error instanceof ProtocolError ? error.code : 'invalid_frame' }, 400)
      }
    }
    const accountRoute = new URL(request.url).searchParams.get('accountRoute') ?? ''
    const sockets = this.ctx.getWebSockets()
    if (sockets.length >= MAX_ACCOUNT_SOCKETS) return json({ code: 'account_socket_limit' }, 429)
    const now = Date.now()
    const ipSignal = request.headers.get('x-alethe-ip-signal') ?? ''
    if (!/^[a-f0-9]{64}$/u.test(ipSignal)) return json({ code: 'invalid_abuse_signal' }, 400)
    const limit = [
      ...this.ctx.storage.sql.exec<{ window_started_at_ms: number; attempts: number }>(
        'SELECT window_started_at_ms, attempts FROM connection_limits WHERE ip_signal = ?',
        ipSignal,
      ),
    ][0]
    if (
      limit &&
      now - limit.window_started_at_ms < AUTH_WINDOW_MS &&
      limit.attempts >= MAX_CONNECTIONS_PER_IP_WINDOW
    ) {
      return json({ code: 'rate_limited' }, 429)
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO connection_limits(ip_signal, window_started_at_ms, attempts) VALUES (?, ?, 1)
       ON CONFLICT(ip_signal) DO UPDATE SET
         attempts = CASE WHEN ? - connection_limits.window_started_at_ms >= ? THEN 1 ELSE connection_limits.attempts + 1 END,
         window_started_at_ms = CASE WHEN ? - connection_limits.window_started_at_ms >= ? THEN ? ELSE connection_limits.window_started_at_ms END`,
      ipSignal,
      now,
      now,
      AUTH_WINDOW_MS,
      now,
      AUTH_WINDOW_MS,
      now,
    )
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const challenge = crypto.randomUUID().replace(/-/gu, '')
    const attachment: SocketAttachment = {
      accountRoute,
      authenticated: false,
      challenge,
      challengeExpiresAtMs: Date.now() + CHALLENGE_TTL_MS,
      ipSignal,
      frameWindowStartedAtMs: now,
      frameCount: 0,
      frameBytes: 0,
    }
    server.serializeAttachment(attachment)
    this.ctx.acceptWebSocket(server)
    server.send(
      JSON.stringify({
        type: 'challenge',
        protocolVersion: RENDEZVOUS_PROTOCOL_VERSION,
        challenge,
        expiresAtMs: attachment.challengeExpiresAtMs,
      }),
    )
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let attachment = socket.deserializeAttachment() as SocketAttachment | null
    if (!attachment) return this.closeWithError(socket, 1008, 'invalid_socket')
    try {
      const now = Date.now()
      const bytes =
        typeof raw === 'string' ? new TextEncoder().encode(raw).byteLength : raw.byteLength
      if (now - attachment.frameWindowStartedAtMs >= AUTH_WINDOW_MS) {
        attachment = { ...attachment, frameWindowStartedAtMs: now, frameCount: 0, frameBytes: 0 }
      }
      attachment.frameCount += 1
      attachment.frameBytes += bytes
      socket.serializeAttachment(attachment)
      if (
        attachment.frameCount > MAX_DEVICE_FRAMES_PER_WINDOW ||
        attachment.frameBytes > MAX_DEVICE_BYTES_PER_WINDOW
      ) {
        throw new ProtocolError('rate_limited')
      }
      const frame = parseClientFrame(raw, Date.now())
      if (!attachment.authenticated) {
        if (frame.type !== 'auth') throw new ProtocolError('authentication_required')
        await this.authenticate(socket, attachment, frame)
        return
      }
      if (frame.type === 'auth') throw new ProtocolError('already_authenticated')
      if (frame.type === 'enqueue') {
        await this.enqueue(attachment.accountRoute, attachment.deviceId!, frame)
      } else if (frame.type === 'ack') this.acknowledge(attachment.deviceId!, frame.id)
      else if (frame.type === 'presence')
        this.updatePresence(attachment.deviceId!, frame.generation, frame.expiresAtMs)
      else if (frame.type === 'pull') await this.deliver(socket, attachment.deviceId!)
      else if (frame.type === 'discover') this.discover(socket, attachment.deviceId!)
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : 'provider_error'
      socket.send(sanitizedError(code))
      if (
        code === 'frame_too_large' ||
        code === 'invalid_json' ||
        code === 'authentication_required'
      ) {
        socket.close(1008, code.slice(0, 48))
      }
    }
  }

  webSocketClose(_socket: WebSocket): void {}
  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket_error')
  }

  private async authenticate(
    socket: WebSocket,
    attachment: SocketAttachment,
    frame: AuthFrame,
  ): Promise<void> {
    const now = Date.now()
    if (
      frame.accountRoute !== attachment.accountRoute ||
      frame.challenge !== attachment.challenge ||
      now > attachment.challengeExpiresAtMs
    ) {
      this.recordAuthFailure(frame.deviceId, now)
      throw new ProtocolError('authentication_failed')
    }
    this.enforceAuthLimit(frame.deviceId, now)
    const publicKey = decodeBase64Url(frame.publicKey)
    const signature = decodeBase64Url(frame.signature)
    if (publicKey.byteLength !== 32 || signature.byteLength !== 64)
      throw new ProtocolError('authentication_failed')
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(publicKey).buffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        key,
        Uint8Array.from(signature).buffer,
        Uint8Array.from(authMessage(frame)).buffer,
      ))
    ) {
      this.recordAuthFailure(frame.deviceId, now)
      throw new ProtocolError('authentication_failed')
    }
    const agreementSignature = decodeBase64Url(frame.agreementBindingSignature)
    if (
      agreementSignature.byteLength !== 64 ||
      !(await crypto.subtle.verify(
        'Ed25519',
        key,
        Uint8Array.from(agreementSignature).buffer,
        Uint8Array.from(agreementBindingMessage(frame)).buffer,
      ))
    ) {
      this.recordAuthFailure(frame.deviceId, now)
      throw new ProtocolError('invalid_agreement_binding')
    }

    const pinned = [
      ...this.ctx.storage.sql.exec<{ public_key: string; key_generation: number }>(
        'SELECT public_key, key_generation FROM devices WHERE device_id = ?',
        frame.deviceId,
      ),
    ][0]
    if (
      pinned &&
      (pinned.public_key !== frame.publicKey || pinned.key_generation > frame.keyGeneration)
    ) {
      this.recordAuthFailure(frame.deviceId, now)
      throw new ProtocolError('device_key_mismatch')
    }
    const sameDeviceSockets = this.ctx.getWebSockets().filter((candidate) => {
      const other = candidate.deserializeAttachment() as SocketAttachment | null
      return other?.authenticated && other.deviceId === frame.deviceId
    })
    if (sameDeviceSockets.length >= MAX_DEVICE_SOCKETS)
      throw new ProtocolError('device_socket_limit')

    this.ctx.storage.sql.exec(
      `INSERT INTO devices(
        device_id, public_key, agreement_public_key, agreement_bound_at_ms,
        agreement_binding_signature, key_generation, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         public_key = excluded.public_key,
         agreement_public_key = excluded.agreement_public_key,
         agreement_bound_at_ms = excluded.agreement_bound_at_ms,
         agreement_binding_signature = excluded.agreement_binding_signature,
         key_generation = MAX(devices.key_generation, excluded.key_generation),
         updated_at_ms = excluded.updated_at_ms`,
      frame.deviceId,
      frame.publicKey,
      frame.agreementPublicKey,
      frame.agreementBoundAtMs,
      frame.agreementBindingSignature,
      frame.keyGeneration,
      now,
    )
    const authenticated: SocketAttachment = {
      ...attachment,
      authenticated: true,
      deviceId: frame.deviceId,
    }
    socket.serializeAttachment(authenticated)
    socket.send(
      JSON.stringify({ type: 'authenticated', protocolVersion: RENDEZVOUS_PROTOCOL_VERSION }),
    )
    await this.cleanup(now)
    await this.deliver(socket, frame.deviceId)
  }

  private enforceAuthLimit(deviceId: string, now: number): void {
    const row = [
      ...this.ctx.storage.sql.exec<{ window_started_at_ms: number; failures: number }>(
        'SELECT window_started_at_ms, failures FROM auth_limits WHERE device_id = ?',
        deviceId,
      ),
    ][0]
    if (
      row &&
      now - row.window_started_at_ms < AUTH_WINDOW_MS &&
      row.failures >= MAX_AUTH_FAILURES_PER_WINDOW
    ) {
      throw new ProtocolError('rate_limited')
    }
  }

  private recordAuthFailure(deviceId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO auth_limits(device_id, window_started_at_ms, failures) VALUES (?, ?, 1)
       ON CONFLICT(device_id) DO UPDATE SET
         failures = CASE WHEN ? - auth_limits.window_started_at_ms >= ? THEN 1 ELSE auth_limits.failures + 1 END,
         window_started_at_ms = CASE WHEN ? - auth_limits.window_started_at_ms >= ? THEN ? ELSE auth_limits.window_started_at_ms END`,
      deviceId,
      now,
      now,
      AUTH_WINDOW_MS,
      now,
      AUTH_WINDOW_MS,
      now,
    )
  }

  private async enqueue(
    localAccountRoute: string,
    senderDeviceId: string,
    frame: EnqueueFrame,
  ): Promise<void> {
    if (frame.recipientAccountRoute !== localAccountRoute) {
      const targetId = this.env.ACCOUNT_ROUTES.idFromName(frame.recipientAccountRoute)
      const response = await this.env.ACCOUNT_ROUTES.get(targetId).fetch(
        new Request('https://durable-object/internal/enqueue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-alethe-internal': '1' },
          body: JSON.stringify({ senderDeviceId, frame }),
        }),
      )
      if (!response.ok) throw new ProtocolError('recipient_mailbox_unavailable')
      return
    }
    await this.persistEnvelope(senderDeviceId, frame)
  }

  private async persistEnvelope(senderDeviceId: string, frame: EnqueueFrame): Promise<void> {
    const now = Date.now()
    await this.cleanup(now)
    const stats = [
      ...this.ctx.storage.sql.exec<{ item_count: number; byte_count: number }>(
        'SELECT COUNT(*) AS item_count, COALESCE(SUM(ciphertext_bytes), 0) AS byte_count FROM mailbox',
      ),
    ][0]
    const estimatedBytes = Math.ceil((frame.ciphertext.length * 3) / 4)
    if (
      !stats ||
      stats.item_count >= MAX_MAILBOX_ITEMS ||
      stats.byte_count + estimatedBytes > MAX_MAILBOX_BYTES
    ) {
      throw new ProtocolError('mailbox_full')
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO mailbox(
        id, kind, sender_device_id, recipient_device_id, authorization_generation,
        ciphertext, ciphertext_bytes, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      frame.id,
      frame.kind,
      senderDeviceId,
      frame.recipientDeviceId ?? null,
      frame.authorizationGeneration,
      frame.ciphertext,
      estimatedBytes,
      now,
      frame.expiresAtMs,
    )
    for (const socket of this.ctx.getWebSockets()) {
      const target = socket.deserializeAttachment() as SocketAttachment | null
      if (
        target?.authenticated &&
        target.deviceId &&
        target.deviceId !== senderDeviceId &&
        (!frame.recipientDeviceId || target.deviceId === frame.recipientDeviceId)
      ) {
        await this.deliver(socket, target.deviceId)
      }
    }
  }

  private async deliver(socket: WebSocket, deviceId: string): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{
      id: string
      kind: string
      sender_device_id: string
      authorization_generation: number
      ciphertext: string
      expires_at_ms: number
    }>(
      `SELECT id, kind, sender_device_id, authorization_generation, ciphertext, expires_at_ms
       FROM mailbox
       WHERE expires_at_ms > ? AND sender_device_id <> ?
         AND (recipient_device_id IS NULL OR recipient_device_id = ?)
       ORDER BY created_at_ms ASC LIMIT ?`,
      Date.now(),
      deviceId,
      deviceId,
      MAX_DELIVERY_BATCH,
    )
    for (const row of rows) {
      socket.send(
        JSON.stringify({
          type: 'delivery',
          id: row.id,
          kind: row.kind,
          senderDeviceId: row.sender_device_id,
          authorizationGeneration: row.authorization_generation,
          ciphertext: row.ciphertext,
          expiresAtMs: row.expires_at_ms,
        }),
      )
    }
  }

  private acknowledge(deviceId: string, id: string): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM mailbox WHERE id = ? AND sender_device_id <> ? AND (recipient_device_id IS NULL OR recipient_device_id = ?)',
      id,
      deviceId,
      deviceId,
    )
  }

  private updatePresence(deviceId: string, generation: number, expiresAtMs: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE devices SET
        presence_generation = MAX(presence_generation, ?),
        presence_expires_at_ms = CASE WHEN ? >= presence_generation THEN ? ELSE presence_expires_at_ms END,
        updated_at_ms = ?
       WHERE device_id = ?`,
      generation,
      generation,
      expiresAtMs,
      Date.now(),
      deviceId,
    )
  }

  private discover(socket: WebSocket, ownDeviceId: string): void {
    const now = Date.now()
    const devices = [
      ...this.ctx.storage.sql.exec<{
        device_id: string
        public_key: string
        agreement_public_key: string
        agreement_bound_at_ms: number
        agreement_binding_signature: string
        key_generation: number
        revocation_generation: number
        presence_expires_at_ms: number
      }>(
        `SELECT device_id, public_key, agreement_public_key, agreement_bound_at_ms,
              agreement_binding_signature, key_generation, revocation_generation,
              presence_expires_at_ms
       FROM devices WHERE device_id <> ? ORDER BY device_id LIMIT 64`,
        ownDeviceId,
      ),
    ].map((device) => ({
      deviceId: device.device_id,
      publicKey: device.public_key,
      agreementPublicKey: device.agreement_public_key,
      agreementBoundAtMs: device.agreement_bound_at_ms,
      agreementBindingSignature: device.agreement_binding_signature,
      keyGeneration: device.key_generation,
      revocationGeneration: device.revocation_generation,
      online: device.presence_expires_at_ms > now,
    }))
    socket.send(JSON.stringify({ type: 'devices', devices }))
  }

  private async cleanup(now: number): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM mailbox WHERE expires_at_ms <= ?', now)
    this.ctx.storage.sql.exec(
      'DELETE FROM auth_limits WHERE window_started_at_ms < ?',
      now - AUTH_WINDOW_MS,
    )
    this.ctx.storage.sql.exec(
      'DELETE FROM connection_limits WHERE window_started_at_ms < ?',
      now - AUTH_WINDOW_MS,
    )
  }

  private closeWithError(socket: WebSocket, closeCode: number, code: string): void {
    socket.send(sanitizedError(code))
    socket.close(closeCode, code.slice(0, 48))
  }
}
