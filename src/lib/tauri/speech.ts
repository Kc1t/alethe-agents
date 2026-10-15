import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { CloudVoiceProviderId, SttProviderId } from '../types'
import type { CloudErrorKind } from './voiceProviders'

export const APPLE_SPEECH_MODEL_ID = 'apple-speech'

export type NativeLocale = { id: string; name: string; installed: boolean }

export type SpeechModelManifest = {
  id: string
  label: string
  description: string
  language: string
  sampleRate: number
  sizeBytes: number
  recommended: boolean
  kind: 'download' | 'native'
  /** Absent until the backend reports it; treated as speech to text. */
  capability?: 'stt' | 'tts'
}

export type SpeechModelState = {
  id: string
  status: 'not-downloaded' | 'downloading' | 'ready' | 'error' | string
  progress?: number | null
  error?: string | null
}

export type SpeechDownloadProgress = {
  modelId: string
  downloaded: number
  total: number
  fraction: number
  /** `verifying` while the SHA-256 of a finished file is checked. */
  phase: 'downloading' | 'verifying'
  file: string
  /** 1-based position of `file` among the model's files. */
  fileIndex: number
  fileCount: number
}

export type SpeechInputDevice = {
  deviceId: string
  label: string
  isDefault: boolean
}

export type CapturedAudio = {
  samples: number[]
  sampleRate: number
  peak: number
}

export async function speechListModels(): Promise<SpeechModelManifest[]> {
  return invoke('speech_list_models')
}

export async function speechListInputDevices(): Promise<SpeechInputDevice[]> {
  return invoke('speech_list_input_devices')
}

export async function speechModelStates(locale?: string | null): Promise<SpeechModelState[]> {
  return invoke('speech_model_states', { locale: locale ?? null })
}

export async function speechDownloadModel(
  modelId: string,
  locale?: string | null,
): Promise<SpeechModelState> {
  return invoke('speech_download_model', { modelId, locale: locale ?? null })
}

export async function speechDeleteModel(modelId: string): Promise<void> {
  await invoke('speech_delete_model', { modelId })
}

/** Start native mic capture (cpal). Pass null for the system default device. */
export async function speechStartCapture(deviceId: string | null): Promise<void> {
  await invoke('speech_start_capture', { deviceId })
}

/** Peak amplitude (0..1) of the most recent captured block; 0 when not recording. */
export async function speechCaptureLevel(): Promise<number> {
  return invoke('speech_capture_level')
}

export async function speechStopCapture(): Promise<CapturedAudio> {
  return invoke('speech_stop_capture')
}

export type SttCallOptions = {
  provider: SttProviderId
  fallbackLocale: string | null
  usage: string
}

/** Loads the model, requests Apple permission, or checks a cloud key; true when ready. */
export async function speechPrepare(
  modelId: string,
  locale?: string | null,
  provider?: SttProviderId,
): Promise<boolean> {
  return invoke('speech_prepare', { provider: provider ?? null, modelId, locale: locale ?? null })
}

/** Stop capture and transcribe with the chosen provider; a cloud failure falls back to local. */
export async function speechStopAndTranscribe(
  modelId: string,
  locale?: string | null,
  options?: SttCallOptions,
): Promise<string> {
  return invoke('speech_stop_and_transcribe', {
    provider: options?.provider ?? null,
    modelId,
    locale: locale ?? null,
    fallbackLocale: options?.fallbackLocale ?? null,
    usage: options?.usage ?? null,
  })
}

export type VoiceFallbackEvent = {
  usage: string
  provider: CloudVoiceProviderId | 'system'
  reason: CloudErrorKind
  fallback: string
}

export async function onVoiceFallback(
  handler: (event: VoiceFallbackEvent) => void,
): Promise<UnlistenFn> {
  return listen<VoiceFallbackEvent>('voice://fallback', (event) => handler(event.payload))
}

export async function speechTranscribe(
  modelId: string,
  samples: Float32Array | number[],
  sampleRate: number,
  locale?: string | null,
): Promise<string> {
  const payload = Array.from(samples)
  return invoke('speech_transcribe', {
    modelId,
    samples: payload,
    sampleRate,
    locale: locale ?? null,
  })
}

export async function speechNativeLocales(): Promise<NativeLocale[]> {
  return invoke('speech_native_locales')
}

export async function onSpeechDownloadProgress(
  handler: (progress: SpeechDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<SpeechDownloadProgress>('speech://download-progress', (event) => {
    handler(event.payload)
  })
}
