import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCoreHealth,
  dataRootFingerprint,
  expectedAppIdentifier,
  expectedCoreIdentity,
  probeCore,
} from './web-launcher-lib.mjs'

const healthy = {
  status: 'ok',
  service: 'alethe-core',
  runtime: {
    service: 'alethe-core',
    apiVersion: 1,
    instanceId: 'alethe-42-test',
    mode: 'embedded',
    appIdentifier: 'com.kc1t.alethe.dev',
    dataRootId: 'storage-a',
  },
}

test('accepts only a matching service, API, identifier, storage root, and instance', () => {
  assert.equal(
    classifyCoreHealth(healthy, {
      appIdentifier: 'com.kc1t.alethe.dev',
      dataRootId: 'storage-a',
    }).status,
    'compatible',
  )
  assert.equal(
    classifyCoreHealth(healthy, {
      appIdentifier: 'com.kc1t.alethe.dev',
      dataRootId: 'storage-b',
    }).status,
    'incompatible',
  )
  assert.equal(
    classifyCoreHealth(
      { ...healthy, runtime: { ...healthy.runtime, apiVersion: 2 } },
      { appIdentifier: 'com.kc1t.alethe.dev' },
    ).status,
    'incompatible',
  )
})

test('treats an unreachable listener as absent', async () => {
  const result = await probeCore({
    fetchImpl: async () => {
      throw new TypeError('fetch failed')
    },
  })
  assert.equal(result.status, 'absent')
})

test('uses the explicit identifier and matches the Rust FNV-1a fingerprint', async () => {
  assert.equal(
    expectedAppIdentifier({ ALETHE_APP_IDENTIFIER: 'com.example.alethe' }),
    'com.example.alethe',
  )
  assert.match(await dataRootFingerprint(process.cwd()), /^[a-f0-9]{16}$/)
  assert.equal(
    (
      await expectedCoreIdentity({
        ALETHE_APP_IDENTIFIER: 'com.example.alethe',
        ALETHE_APP_DATA_DIR: process.cwd(),
      })
    ).dataRootId,
    await dataRootFingerprint(process.cwd()),
  )
})
