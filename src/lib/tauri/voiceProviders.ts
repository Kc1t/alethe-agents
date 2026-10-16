import { invoke } from '@tauri-apps/api/core'

import type { CloudVoiceProviderId } from '../types'

export type CloudErrorKind = 'network' | 'auth' | 'quota' | 'badAudio' | 'timeout' | 'other'
export type VoiceCatalogModel = {
  id: string
  label: string
  capability: 'stt' | 'tts'
  /** Voices the model speaks; only OpenRouter's live list carries them. */
  voices?: string[]
  /** OpenRouter's per-unit price (`$input` or `$input · $output`); the unit is not published. */
  price?: string
}
export type VoiceCatalogVoice = { id: string; label: string }
export type VoiceProviderCatalog = {
  provider: CloudVoiceProviderId
  keyUrl: string
  models: VoiceCatalogModel[]
  voices: VoiceCatalogVoice[]
}
export type VoiceTestResult = { ok: boolean; reason: CloudErrorKind | null }

export async function voiceProviderSetKey(
  provider: CloudVoiceProviderId,
  key: string,
): Promise<void> {
  await invoke('voice_provider_set_key', { provider, key })
}

export async function voiceProviderDeleteKey(provider: CloudVoiceProviderId): Promise<void> {
  await invoke('voice_provider_delete_key', { provider })
}

export function voiceProviderTest(provider: CloudVoiceProviderId): Promise<VoiceTestResult> {
  return invoke('voice_provider_test', { provider })
}

export function voiceProviderCatalog(): Promise<VoiceProviderCatalog[]> {
  return invoke('voice_provider_catalog')
}

export function voiceOpenrouterModels(kind: 'stt' | 'tts'): Promise<VoiceCatalogModel[]> {
  return invoke('voice_openrouter_models', { kind })
}
