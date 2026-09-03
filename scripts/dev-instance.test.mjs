import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'

import { findFreePort, isPortFree, LOOPBACK_HOSTS } from './dev-instance.mjs'

/** Binds `host:port` for the duration of `body`, then releases it. */
async function whileListening(host, port, body) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, resolve)
  })
  try {
    await body()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** A port free on both stacks right now, so a test can then occupy one of them deliberately. */
async function freePort(start = 24000) {
  return findFreePort(start, 500)
}

/** Whether this machine can bind the IPv6 loopback at all. */
async function ipv6Available() {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen({ host: '::1', port: 0 }, () => server.close(() => resolve(true)))
  })
}

test('isPortFree covers both loopback stacks', () => {
  assert.deepEqual(LOOPBACK_HOSTS, ['127.0.0.1', '::1'])
})

test('reports a port taken on IPv4 as taken', async () => {
  const port = await freePort()
  await whileListening('127.0.0.1', port, async () => {
    assert.equal(await isPortFree(port), false)
  })
})

test('reports a port taken ONLY on IPv6 as taken', async (t) => {
  // The exact shape of the bug this scan was failing at: a stale process listening on `[::1]:1594`
  // while `127.0.0.1:1594` was wide open. An IPv4-only probe called the port free, and Vite — which
  // resolves `localhost` to `::1` first on Windows — then failed to bind it.
  if (!(await ipv6Available())) return t.skip('no IPv6 loopback on this machine')
  const port = await freePort()
  await whileListening('::1', port, async () => {
    assert.equal(await isPortFree(port), false)
  })
})

test('reports a port free on both stacks as free', async () => {
  const port = await freePort()
  assert.equal(await isPortFree(port), true)
})

test('findFreePort skips a port held on IPv6 only', async (t) => {
  if (!(await ipv6Available())) return t.skip('no IPv6 loopback on this machine')
  const port = await freePort()
  await whileListening('::1', port, async () => {
    const chosen = await findFreePort(port, 20)
    assert.notEqual(chosen, port)
    assert.ok(chosen > port, 'scans upward from the preferred port')
  })
})

test('findFreePort returns the preferred port when it is free', async () => {
  const port = await freePort()
  assert.equal(await findFreePort(port, 20), port)
})

test('findFreePort throws rather than returning a taken port', async () => {
  const port = await freePort()
  await whileListening('127.0.0.1', port, async () => {
    await assert.rejects(() => findFreePort(port, 1), /No free port found/)
  })
})
