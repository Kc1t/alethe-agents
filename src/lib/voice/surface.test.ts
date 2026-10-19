import { describe, expect, it } from 'vitest'

import { HUD_IDLE_HIDE_MS, voiceSurface } from './surface'

const base = { mainFocused: false, active: true, idleSince: null, now: 10_000, dismissed: false }

describe('voiceSurface', () => {
  it('uses the panel whenever Alethe is focused', () => {
    expect(voiceSurface({ ...base, mainFocused: true })).toBe('dock')
    expect(voiceSurface({ ...base, mainFocused: true, active: false, idleSince: 0 })).toBe('dock')
  })
  it('uses the HUD while a conversation is active and Alethe is not focused', () => {
    expect(voiceSurface(base)).toBe('hud')
  })
  it('keeps the HUD for 4 s after the turn ends, then hides it', () => {
    expect(voiceSurface({ ...base, active: false, idleSince: 10_000 - HUD_IDLE_HIDE_MS + 1 })).toBe(
      'hud',
    )
    expect(voiceSurface({ ...base, active: false, idleSince: 10_000 - HUD_IDLE_HIDE_MS })).toBe(
      'none',
    )
    expect(voiceSurface({ ...base, active: false, idleSince: null })).toBe('none')
  })
  it('stays hidden after the person closed it, until the next press', () => {
    expect(voiceSurface({ ...base, dismissed: true })).toBe('none')
  })
})
