import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type SpeechModelManifest = {
  id: string
  label: string
  description: string
  language: string
  sampleRate: number
  sizeBytes: number
  recommended: boolean
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

export async function speechModelStates(): Promise<SpeechModelState[]> {
  return invoke('speech_model_states')
}

export async function speechDownloadModel(modelId: string): Promise<SpeechModelState> {
  return invoke('speech_download_model', { modelId })
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

/** Stop native capture and run on-device STT in one round-trip. */
export async function speechPrepare(modelId: string): Promise<boolean> {
  return invoke('speech_prepare', { modelId })
}

export async function speechStopAndTranscribe(modelId: string): Promise<string> {
  return invoke('speech_stop_and_transcribe', { modelId })
}

export async function speechTranscribe(
  modelId: string,
  samples: Float32Array | number[],
  sampleRate: number,
): Promise<string> {
  const payload = Array.from(samples)
  return invoke('speech_transcribe', { modelId, samples: payload, sampleRate })
}

export async function onSpeechDownloadProgress(
  handler: (progress: SpeechDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<SpeechDownloadProgress>('speech://download-progress', (event) => {
    handler(event.payload)
  })
}
