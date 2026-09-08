const endpoint = process.env.ALETHE_RENDEZVOUS_TEST_ENDPOINT ?? 'http://127.0.0.1:8799'
const websocketEndpoint = endpoint.replace(/^http/u, 'ws')
const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

async function connect(accountRoute) {
  const deviceId = `device_local_${crypto.randomUUID().replaceAll('-', '')}`
  const identity = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey))
  const agreementPublicKey = crypto.getRandomValues(new Uint8Array(32))
  const agreementBoundAtMs = BigInt(Date.now())
  const encodedDevice = new TextEncoder().encode(deviceId)
  const binding = new Uint8Array(4 + encodedDevice.length + 32 + 32 + 8)
  const view = new DataView(binding.buffer)
  view.setUint32(0, encodedDevice.length, true)
  binding.set(encodedDevice, 4)
  binding.set(publicKey, 4 + encodedDevice.length)
  binding.set(agreementPublicKey, 4 + encodedDevice.length + 32)
  view.setBigUint64(4 + encodedDevice.length + 64, agreementBoundAtMs, true)
  const agreementBindingSignature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', identity.privateKey, binding),
  )

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${websocketEndpoint}/v1/connect?accountRoute=${accountRoute}`)
    const timeout = setTimeout(() => reject(new Error('authentication timeout')), 10_000)
    socket.onmessage = async (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'challenge') {
        const authMessage = [
          'alethe-rendezvous-auth-v1',
          accountRoute,
          deviceId,
          '1',
          message.challenge,
          '1',
        ].join('\n')
        const signature = new Uint8Array(
          await crypto.subtle.sign(
            'Ed25519',
            identity.privateKey,
            new TextEncoder().encode(authMessage),
          ),
        )
        socket.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: 1,
            accountRoute,
            deviceId,
            publicKey: base64url(publicKey),
            agreementPublicKey: base64url(agreementPublicKey),
            agreementBoundAtMs: Number(agreementBoundAtMs),
            agreementBindingSignature: base64url(agreementBindingSignature),
            keyGeneration: 1,
            challenge: message.challenge,
            signature: base64url(signature),
          }),
        )
      } else if (message.type === 'authenticated') {
        clearTimeout(timeout)
        resolve({ socket, deviceId })
      } else if (message.type === 'error') {
        reject(new Error(message.code))
      }
    }
    socket.onerror = reject
  })
}

const senderRoute = 'c'.repeat(64)
const recipientRoute = 'd'.repeat(64)
const recipient = await connect(recipientRoute)
const sender = await connect(senderRoute)
const messageId = `message_${crypto.randomUUID().replaceAll('-', '')}`

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('cross-account delivery timeout')), 10_000)
  recipient.socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.type === 'delivery' && message.id === messageId) {
      clearTimeout(timeout)
      recipient.socket.send(JSON.stringify({ type: 'ack', id: messageId }))
      resolve()
    }
  })
  sender.socket.send(
    JSON.stringify({
      type: 'enqueue',
      id: messageId,
      kind: 'invitation',
      recipientAccountRoute: recipientRoute,
      recipientDeviceId: recipient.deviceId,
      expiresAtMs: Date.now() + 60_000,
      authorizationGeneration: 1,
      ciphertext: 'AQIDBA',
    }),
  )
})

sender.socket.close()
recipient.socket.close()
console.log('Local cross-account encrypted-envelope routing passed.')
