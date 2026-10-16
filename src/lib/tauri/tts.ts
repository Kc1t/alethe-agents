import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { TtsChoice, TtsProviderId } from '../types'

export type TtsVoice = { id: string; name: string; language: string }

/** Speaks `text` with the chosen provider, interrupting anything already playing. Resolves to the utterance id. */
export function ttsSpeak(text: string, choice: TtsChoice): Promise<number> {
  return invoke<number>('tts_speak', {
    text,
    voice: choice.voice,
    rate: choice.rate,
    provider: choice.provider,
    model: choice.model || null,
  })
}

export async function ttsStop(): Promise<void> {
  await invoke('tts_stop')
}

/** Holds cloud and local narration where it is; the system voice cannot be held (see narrator). */
export async function ttsPause(): Promise<void> {
  await invoke('tts_pause')
}

export async function ttsResume(): Promise<void> {
  await invoke('tts_resume')
}

/** Narration keeps its pace with no sound, for the rest of the session. */
export async function ttsSetMuted(muted: boolean): Promise<void> {
  await invoke('tts_set_muted', { muted })
}

/** Voices of a provider; OpenRouter lists the voices of `model`, a local server those of `server`. */
export function ttsVoices(
  provider?: TtsProviderId,
  model?: string,
  server?: string | null,
): Promise<TtsVoice[]> {
  return invoke<TtsVoice[]>('tts_voices', {
    provider: provider ?? null,
    model: model || null,
    server: server ?? null,
  })
}

/** Fires when an utterance finishes, on engines that report it; callers keep their own timeout. */
export function onTtsEnd(handler: (id: number) => void): Promise<UnlistenFn> {
  return listen<{ id: number }>('tts://end', (event) => handler(event.payload.id))
}

/**
 * Fires when an utterance becomes audible: from the system voice on engines that report it, and
 * from the cloud/local player once its first chunk is queued.
 */
export function onTtsStart(handler: (id: number) => void): Promise<UnlistenFn> {
  return listen<{ id: number }>('tts://start', (event) => handler(event.payload.id))
}

/**
 * Where the cloud/local player is in an utterance's text, in code points; about ten times a
 * second while it moves (still while paused, on while muted). The system voice reports none.
 */
export function onTtsProgress(
  handler: (id: number, charOffset: number) => void,
): Promise<UnlistenFn> {
  return listen<{ id: number; charOffset: number }>('tts://progress', (event) =>
    handler(event.payload.id, event.payload.charOffset),
  )
}
