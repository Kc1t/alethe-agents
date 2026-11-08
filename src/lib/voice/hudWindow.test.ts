import { describe, expect, it } from 'vitest'

import { isVoiceHudWindow } from './hudWindow'

describe('isVoiceHudWindow', () => {
  it('recognises only the voice HUD window label', () => {
    expect(isVoiceHudWindow('voice-hud')).toBe(true)
    expect(isVoiceHudWindow('main')).toBe(false)
    expect(isVoiceHudWindow('orchestration-voice-hud')).toBe(false)
    expect(isVoiceHudWindow('voice-hud-2')).toBe(false)
    expect(isVoiceHudWindow(null)).toBe(false)
  })
})
