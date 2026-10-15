import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(() => Promise.resolve()) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { hudPlacement, voiceHudShow, voiceShortcutSet } from './voiceHud'

describe('voice HUD wrappers', () => {
  beforeEach(() => invoke.mockClear())

  it('builds a preset placement', () => {
    expect(hudPlacement('top-left', null)).toEqual({ kind: 'preset', preset: 'top-left' })
  })

  it('uses the custom position only when there is one', () => {
    const custom = { monitor: 'DELL', x: 0.2, y: 0.3 }
    expect(hudPlacement('custom', custom)).toEqual({ kind: 'custom', custom })
    expect(hudPlacement('custom', null)).toEqual({ kind: 'preset', preset: 'bottom-center' })
  })

  it('sends the placement to voice_hud_show', async () => {
    await voiceHudShow({ kind: 'preset', preset: 'bottom-center' })
    expect(invoke).toHaveBeenCalledWith('voice_hud_show', {
      placement: { kind: 'preset', preset: 'bottom-center' },
    })
  })

  it('sends null to clear the shortcut', async () => {
    await voiceShortcutSet(null)
    expect(invoke).toHaveBeenCalledWith('voice_shortcut_set', { accelerator: null })
  })
})
