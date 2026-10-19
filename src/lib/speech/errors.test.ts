import { describe, expect, it } from 'vitest'

import { isSpeechTooShort } from './errors'

describe('isSpeechTooShort', () => {
  it('recognizes the code Rust sends for a recording too short to transcribe', () => {
    expect(isSpeechTooShort('speech_too_short')).toBe(true)
    expect(isSpeechTooShort(new Error('speech_too_short'))).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isSpeechTooShort('voice_cloud_auth (HTTP 401)')).toBe(false)
    expect(isSpeechTooShort(new Error('No audio captured.'))).toBe(false)
    expect(isSpeechTooShort(undefined)).toBe(false)
  })
})
