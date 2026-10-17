import type { VoiceNarration, VoiceNarrationCategory, VoiceVerbosity } from '../types'

/** In the order Preferences lists them. */
export const NARRATION_CATEGORIES: readonly VoiceNarrationCategory[] = [
  'progress',
  'thinking',
  'tools',
  'status',
  'final',
  'permissions',
  'questions',
]

const NONE: VoiceNarration = {
  progress: false,
  thinking: false,
  tools: false,
  status: false,
  final: false,
  permissions: false,
  questions: false,
}

/**
 * The quick choices. Each says exactly what its verbosity spoke before the toggles existed, so a
 * migrated profile hears the same; thinking and questions came with the toggles and are off.
 */
export const NARRATION_PRESETS: Readonly<Record<VoiceVerbosity, VoiceNarration>> = {
  silent: { ...NONE, permissions: true },
  final: { ...NONE, final: true, permissions: true },
  normal: { ...NONE, progress: true, status: true, final: true, permissions: true },
  detailed: { ...NONE, progress: true, tools: true, status: true, final: true, permissions: true },
}

const VERBOSITIES = Object.keys(NARRATION_PRESETS) as VoiceVerbosity[]

/** The preset these toggles match, or `custom`. */
export function narrationPreset(toggles: VoiceNarration): VoiceVerbosity | 'custom' {
  return (
    VERBOSITIES.find((level) =>
      NARRATION_CATEGORIES.every((key) => NARRATION_PRESETS[level][key] === toggles[key]),
    ) ?? 'custom'
  )
}

/**
 * The saved toggles, completed and cleaned. Profiles from before the toggles have only
 * `voiceVerbosity` (`legacyVerbosity`): its preset gives every toggle, and also fills any toggle a
 * partial value lacks.
 */
export function normalizeNarration(value: unknown, legacyVerbosity: unknown): VoiceNarration {
  const base =
    NARRATION_PRESETS[
      VERBOSITIES.includes(legacyVerbosity as VoiceVerbosity)
        ? (legacyVerbosity as VoiceVerbosity)
        : 'normal'
    ]
  const saved =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Object.fromEntries(
    NARRATION_CATEGORIES.map((key) => [
      key,
      typeof saved[key] === 'boolean' ? saved[key] : base[key],
    ]),
  ) as VoiceNarration
}
