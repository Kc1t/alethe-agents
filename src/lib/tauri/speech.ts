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
  kind: 'download' | 'native'

  capability?: 'stt' | 'tts'

  source?: 'catalog' | 'huggingface'
  hub?: HubModelInfo
}

export type SpeechModelState = {
  id: string
  status: 'not-downloaded' | 'downloading' | 'paused' | 'ready' | 'error' | string
  progress?: number | null
  error?: string | null
  downloadedBytes?: number | null
  totalBytes?: number | null
}

export const DOWNLOAD_PAUSED = 'speech_download_paused'

export const DOWNLOAD_BUSY = 'speech_download_busy'

export type SpeechDownloadProgress = {
  modelId: string
  downloaded: number
  total: number
  fraction: number

  phase: 'downloading' | 'verifying' | 'unpacking' | 'paused'
  file: string

  fileIndex: number
  fileCount: number
}

export type HubFamily =
  | 'vits'
  | 'kokoro'
  | 'kitten'
  | 'transducer'
  | 'nemo-transducer'
  | 'whisper'
  | 'moonshine'
  | 'sense-voice'
  | 'paraformer'
  | 'nemo-ctc'
  | 'dolphin'

export type HubModelInfo = {
  repo: string

  commit: string | null
  family: HubFamily
  languages: string[]
  languageCount: number | null
  multilingual: boolean

  speed: number | null
  accuracy: number | null
  voiceCount: number | null
  license: string | null
  lastModified: string | null
  likes: number
  fileCount: number | null
  totalBytes: number | null
}

export type HubSearchResult = { id: string; use: 'stt' | 'tts'; label: string; hub: HubModelInfo }
export type HubSearchQuery = {
  use: 'stt' | 'tts' | null
  query: string
  language: string | null
  sort: 'likes' | 'recent'
  offset: number
}
export type HubSearchPage = { results: HubSearchResult[]; hasMore: boolean }

export const HUB_ERROR = {
  offline: 'hub_offline',
  rateLimited: 'hub_rate_limited',
  unavailable: 'hub_unavailable',
  badResponse: 'hub_bad_response',
  incompatible: 'hub_incompatible',
  tooLarge: 'hub_too_large',
  gated: 'hub_gated',
  unknownRepo: 'hub_unknown_repo',
} as const

export async function speechHubSearch(query: HubSearchQuery): Promise<HubSearchPage> {
  return invoke('speech_hub_search', { query })
}

export async function speechHubResolve(repo: string): Promise<HubSearchResult> {
  return invoke('speech_hub_resolve', { repo })
}

export async function speechListModels(): Promise<SpeechModelManifest[]> {
  return invoke('speech_list_models')
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

export async function speechPauseDownload(modelId: string): Promise<boolean> {
  return invoke('speech_pause_download', { modelId })
}

export async function speechCancelDownload(modelId: string): Promise<void> {
  await invoke('speech_cancel_download', { modelId })
}

export async function speechDeleteModel(modelId: string): Promise<void> {
  await invoke('speech_delete_model', { modelId })
}

export async function onSpeechDownloadProgress(
  handler: (progress: SpeechDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<SpeechDownloadProgress>('speech://download-progress', (event) => {
    handler(event.payload)
  })
}
