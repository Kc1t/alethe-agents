import { describe, expect, it } from 'vitest'

import { serverErrorKey } from './serverErrors'

describe('serverErrorKey', () => {
  it('maps backend codes to messages', () => {
    expect(serverErrorKey('voice_server_policy')).toBe('prefs.voiceServerError.policy')
    expect(serverErrorKey(new Error('voice_server_invalidName'))).toBe(
      'prefs.voiceServerError.invalidName',
    )
    expect(serverErrorKey('voice_server_invalidUrl')).toBe('prefs.voiceServerError.invalidUrl')
    expect(serverErrorKey('network')).toBe('prefs.voiceServerError.network')
  })

  it('reads anything unknown as other', () => {
    expect(serverErrorKey('boom')).toBe('prefs.voiceServerError.other')
    expect(serverErrorKey(undefined)).toBe('prefs.voiceServerError.other')
  })
})
