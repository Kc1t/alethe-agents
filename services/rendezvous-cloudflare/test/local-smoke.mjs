const endpoint = process.env.ALETHE_RENDEZVOUS_TEST_ENDPOINT ?? 'http://127.0.0.1:8799'
const accountRoute = 'a'.repeat(64)
const deviceId = `device_local_${crypto.randomUUID().replaceAll('-', '')}`

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

const info = await (await fetch(`${endpoint}/v1/info`)).json()
if (info.protocolMin !== 1 || info.protocolMax !== 1) throw new Error('incompatible info response')

const identity = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey))
const agreementPublicKey = crypto.getRandomValues(new Uint8Array(32))
const agreementBoundAtMs = 1_234n
const encodedDevice = new TextEncoder().encode(deviceId)
const binding = new Uint8Array(4 + encodedDevice.length + 32 + 32 + 8)
const bindingView = new DataView(binding.buffer)
bindingView.setUint32(0, encodedDevice.length, true)
binding.set(encodedDevice, 4)
binding.set(publicKey, 4 + encodedDevice.length)
binding.set(agreementPublicKey, 4 + encodedDevice.length + 32)
bindingView.setBigUint64(4 + encodedDevice.length + 64, agreementBoundAtMs, true)
const agreementBindingSignature = new Uint8Array(
  await crypto.subtle.sign('Ed25519', identity.privateKey, binding),
)

await new Promise((resolve, reject) => {
  const websocketEndpoint = endpoint.replace(/^http/u, 'ws')
  const socket = new WebSocket(`${websocketEndpoint}/v1/connect?accountRoute=${accountRoute}`)
  const timeout = setTimeout(() => reject(new Error('local smoke timeout')), 10_000)
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
      socket.send(JSON.stringify({ type: 'discover' }))
    } else if (message.type === 'devices') {
      clearTimeout(timeout)
      socket.close()
      resolve()
    } else if (message.type === 'error') {
      reject(new Error(message.code))
    }
  }
  socket.onerror = reject
})

console.log('Local rendezvous challenge/authentication/discovery passed.')
