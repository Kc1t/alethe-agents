import { describe, expect, it } from 'vitest'

import * as voiceProviders from './voiceProviders'

describe('voice provider wrappers', () => {
  it('has no command that reads every saved key at once', () => {
    expect('voiceProvidersStatus' in voiceProviders).toBe(false)
  })
})
