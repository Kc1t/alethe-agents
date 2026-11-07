import { pluginsList } from '../tauri/plugins'
import { voiceProviderKeyStatus, voiceProviderSetKey } from '../tauri/voiceProviders'
import { setPluginEnabled } from './host'
import { createPluginStorage } from './storage'

export const GIT_CONTROL_PLUGIN_ID = 'alethe.git-control'
export const TODOS_PLUGIN_ID = 'alethe.todos'
export const JEV_PLUGIN_ID = 'alethe.jev'
const JEV_KEYCHAIN_VERSION = [1, 1, 0]

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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function atLeast(version: string, minimum: number[]): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < minimum.length; index += 1) {
    const part = parts[index] ?? 0
    if (part !== minimum[index]) return part > minimum[index]
  }
  return true
}

async function jevReadsKeychain(): Promise<boolean> {
  const jev = (await pluginsList()).find((plugin) => plugin.id === JEV_PLUGIN_ID)
  return jev !== undefined && atLeast(jev.version, JEV_KEYCHAIN_VERSION)
}

// Jev 1.0 kept its OpenRouter key in plugin storage; 1.1 reads the keychain instead.
async function moveJevKeyToKeychain(): Promise<void> {
  const storage = createPluginStorage(JEV_PLUGIN_ID)
  const stored = await storage.read()
  const settings = record(stored.settings)
  const legacy = record(stored.legacyPreferences)
  const key = nonEmpty(settings?.apiKey) ?? nonEmpty(legacy?.voiceCommandApiKey)
  if (!key) return
  if (!(await voiceProviderKeyStatus('openrouter'))) await voiceProviderSetKey('openrouter', key)
  if (!(await jevReadsKeychain())) return
  if (settings && nonEmpty(settings.apiKey))
    await storage.set('settings', { ...settings, apiKey: '' })
  if (legacy && nonEmpty(legacy.voiceCommandApiKey)) {
    const { voiceCommandApiKey: _key, ...rest } = legacy
    await storage.set('legacyPreferences', rest)
  }
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
  await moveJevKeyToKeychain().catch((error) => {
    console.error('[plugins] could not move the Jev key to the keychain', error)
  })
}
