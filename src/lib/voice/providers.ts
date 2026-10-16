import type {
  CloudVoiceProviderId,
  SttChoice,
  SttProviderId,
  TtsChoice,
  TtsProviderId,
} from '../types'

export const CLOUD_VOICE_PROVIDERS: readonly CloudVoiceProviderId[] = [
  'openai',
  'elevenlabs',
  'gemini',
  'openrouter',
]
export const STT_PROVIDERS: readonly SttProviderId[] = ['local', 'apple', ...CLOUD_VOICE_PROVIDERS]
export const TTS_PROVIDERS: readonly TtsProviderId[] = [
  'system',
  'local',
  'server',
  ...CLOUD_VOICE_PROVIDERS,
]

export const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'
export const APPLE_MODEL_ID = 'apple-speech'

export const DEFAULT_STT_CHOICE: SttChoice = {
  provider: 'local',
  model: PARAKEET_MODEL_ID,
  locale: null,
}
export const DEFAULT_TTS_CHOICE: TtsChoice = {
  provider: 'system',
  model: '',
  voice: null,
  rate: 1,
  server: null,
}

export function isCloudProvider(id: string): id is CloudVoiceProviderId {
  return (CLOUD_VOICE_PROVIDERS as readonly string[]).includes(id)
}
