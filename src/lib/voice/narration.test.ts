import { describe, expect, it } from 'vitest'

import { DEFAULT_PREFERENCES } from '../types'
import { NARRATION_PRESETS, narrationPreset, normalizeNarration } from './narration'

describe('narration presets', () => {
  // Each preset says exactly what its verbosity used to, so a migrated profile hears the same.
  it('match what each verbosity used to speak', () => {
    expect(NARRATION_PRESETS.silent).toEqual({
      progress: false,
      thinking: false,
      tools: false,
      status: false,
      final: false,
      permissions: true,
      questions: false,
    })
    expect(NARRATION_PRESETS.final).toMatchObject({ final: true, progress: false, status: false })
    expect(NARRATION_PRESETS.normal).toMatchObject({
      progress: true,
      status: true,
      final: true,
      tools: false,
    })
    expect(NARRATION_PRESETS.detailed).toMatchObject({ ...NARRATION_PRESETS.normal, tools: true })
    for (const preset of Object.values(NARRATION_PRESETS)) {
      expect(preset.permissions).toBe(true)
      expect(preset.thinking).toBe(false)
      expect(preset.questions).toBe(false)
    }
  })

  it('the default preferences are the normal preset', () => {
    expect(DEFAULT_PREFERENCES.voiceNarration).toEqual(NARRATION_PRESETS.normal)
  })

  it('names the preset the toggles match, or custom', () => {
    expect(narrationPreset(NARRATION_PRESETS.detailed)).toBe('detailed')
    expect(narrationPreset({ ...NARRATION_PRESETS.silent })).toBe('silent')
    expect(narrationPreset({ ...NARRATION_PRESETS.normal, thinking: true })).toBe('custom')
    expect(narrationPreset({ ...NARRATION_PRESETS.final, permissions: false })).toBe('custom')
  })
})

describe('normalizeNarration', () => {
  it('migrates a saved verbosity to its toggles', () => {
    for (const level of ['silent', 'final', 'normal', 'detailed'] as const) {
      expect(normalizeNarration(undefined, level)).toEqual(NARRATION_PRESETS[level])
    }
  })

  it('backfills the normal preset when nothing was saved, or the verbosity is unknown', () => {
    expect(normalizeNarration(undefined, undefined)).toEqual(NARRATION_PRESETS.normal)
    expect(normalizeNarration(undefined, 'loud')).toEqual(NARRATION_PRESETS.normal)
  })

  it('keeps saved toggles over a leftover verbosity, filling the missing ones from it', () => {
    expect(normalizeNarration({ thinking: true, final: 'yes' }, 'silent')).toEqual({
      ...NARRATION_PRESETS.silent,
      thinking: true,
    })
    expect(normalizeNarration({ ...NARRATION_PRESETS.final }, 'detailed')).toEqual(
      NARRATION_PRESETS.final,
    )
  })

  it('ignores a value of the wrong shape', () => {
    expect(normalizeNarration('detailed', 'final')).toEqual(NARRATION_PRESETS.final)
    expect(normalizeNarration(['progress'], undefined)).toEqual(NARRATION_PRESETS.normal)
  })
})
