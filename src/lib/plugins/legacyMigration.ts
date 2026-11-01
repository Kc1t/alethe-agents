import { setPluginEnabled } from './host'
import { createPluginStorage } from './storage'

export const GIT_CONTROL_PLUGIN_ID = 'alethe.git-control'
export const TODOS_PLUGIN_ID = 'alethe.todos'
export const JEV_PLUGIN_ID = 'alethe.jev'

/** Preference keys the voice features used before Jev moved to its own plugin. */
export const LEGACY_VOICE_PREFERENCE_KEYS = [
  'voiceCommandApiKey',
  'voiceKeepListening',
  'dictationEnabled',
  'dictationMode',
  'dictationModelId',
  'dictationProvider',
  'dictationCloudModel',
  'dictationMicrophoneId',
  'dictationMicrophoneLabel',
] as const

let pendingGitFlag: boolean | undefined
let pendingTodosFlag: boolean | undefined
let pendingVoicePreferences: Record<string, unknown> | undefined

/**
 * Records the pre-plugin `enabledFeatures.git` value seen while loading a
 * profile. Called during preference normalization, which runs before the
 * plugin host knows anything about this profile.
 */
export function recordLegacyGitFlag(value: boolean | undefined): void {
  if (value === undefined) return
  pendingGitFlag = value
}

export function recordLegacyTodosFlag(value: boolean | undefined): void {
  if (value === undefined) return
  pendingTodosFlag = value
}

/** Picks the old voice preferences out of a loaded profile so they can follow Jev. */
export function recordLegacyVoicePreferences(raw: Record<string, unknown> | undefined): void {
  if (!raw) return
  const picked: Record<string, unknown> = {}
  for (const key of LEGACY_VOICE_PREFERENCE_KEYS) {
    if (raw[key] !== undefined) picked[key] = raw[key]
  }
  if (Object.keys(picked).length > 0) pendingVoicePreferences = picked
}

// The plugin reads `legacyPreferences` once and converts it, so the core never learns its schema.
async function handOffVoicePreferences(preferences: Record<string, unknown>): Promise<void> {
  const storage = createPluginStorage(JEV_PLUGIN_ID)
  const record = await storage.read()
  if (record.settings !== undefined || record.legacyPreferences !== undefined) return
  await storage.set('legacyPreferences', preferences)
}

/**
 * Carries the old Git feature toggle over to the plugin's enabled state, once
 * per profile load. Safe to call whenever hydration finishes.
 */
export async function applyLegacyPluginMigrations(): Promise<void> {
  const gitFlag = pendingGitFlag
  const todosFlag = pendingTodosFlag
  const voicePreferences = pendingVoicePreferences
  pendingGitFlag = undefined
  pendingTodosFlag = undefined
  pendingVoicePreferences = undefined
  if (gitFlag === false) await setPluginEnabled(GIT_CONTROL_PLUGIN_ID, false)
  if (todosFlag === false) await setPluginEnabled(TODOS_PLUGIN_ID, false)
  if (voicePreferences) await handOffVoicePreferences(voicePreferences)
}
