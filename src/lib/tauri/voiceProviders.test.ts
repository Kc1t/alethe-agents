import { describe, expect, it } from 'vitest'

import * as voiceProviders from './voiceProviders'

describe('voice provider wrappers', () => {
  it('has no command that reads every saved key at once', () => {
    // Reading all keys on launch raised one keychain prompt per provider on macOS; whether a key
    // is configured comes from the persisted preference flags instead.
    expect('voiceProvidersStatus' in voiceProviders).toBe(false)
  })
})
