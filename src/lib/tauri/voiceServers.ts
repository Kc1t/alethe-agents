import { invoke } from '@tauri-apps/api/core'

import type { VoiceServer, VoiceServerErrorKind, VoiceServerKind } from '../types'

export type VoiceServerInput = {
  id?: string
  name: string
  kind: VoiceServerKind
  baseUrl: string
  model: string | null
}
export type VoiceServerSaved = { server: VoiceServer; loopback: boolean }
export type VoiceServerTest = {
  ok: boolean
  reason: VoiceServerErrorKind | null
  voices: string[]
  loopback: boolean
}

export function voiceServersList(): Promise<VoiceServer[]> {
  return invoke('voice_servers_list')
}

export function voiceServersSave(
  input: VoiceServerInput,
  key?: string | null,
): Promise<VoiceServerSaved> {
  return invoke('voice_servers_save', { input, key: key ?? null })
}

export async function voiceServersDelete(id: string): Promise<void> {
  await invoke('voice_servers_delete', { id })
}

export function voiceServersTest(id: string): Promise<VoiceServerTest> {
  return invoke('voice_servers_test', { id })
}
