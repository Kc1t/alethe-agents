import { describe, expect, it } from 'vitest'

import {
  normalizePermissions,
  parseProjectSyncCapabilities,
  PROJECT_SYNC_CAPABILITIES,
  PROJECT_SYNC_PROTOCOL_VERSION,
  unavailableProjectSyncCapabilities,
} from './contracts'

describe('parseProjectSyncCapabilities', () => {
  it('keeps every production project-sync entry point disabled by default', () => {
    expect(PROJECT_SYNC_CAPABILITIES).toEqual(unavailableProjectSyncCapabilities())
  })

  it('fails closed for absent, malformed, future, or unverified capability documents', () => {
    const unavailable = unavailableProjectSyncCapabilities()

    expect(parseProjectSyncCapabilities(undefined)).toEqual(unavailable)
    expect(parseProjectSyncCapabilities({ protocolVersion: 99 })).toEqual(unavailable)
    expect(
      parseProjectSyncCapabilities({
        ...unavailable,
        verifiedEncryption: true,
      }),
    ).toEqual(unavailable)
  })

  it('accepts the complete current fail-closed contract', () => {
    const capabilities = unavailableProjectSyncCapabilities()
    expect(parseProjectSyncCapabilities(capabilities)).toEqual({
      ...capabilities,
      protocolVersion: PROJECT_SYNC_PROTOCOL_VERSION,
    })
  })
})

describe('normalizePermissions', () => {
  it('makes read implications explicit for export, write, delete, and manage', () => {
    expect(normalizePermissions(['export', 'write', 'delete', 'manage'])).toEqual([
      'export',
      'write',
      'delete',
      'manage',
      'read',
    ])
  })

  it('keeps upload as an isolated write-only inbox capability', () => {
    expect(normalizePermissions(['upload'])).toEqual(['upload'])
  })
})
