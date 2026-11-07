import type { CloudVoiceProviderId } from '../types'
export const CLOUD_VOICE_PROVIDERS: readonly CloudVoiceProviderId[] = [
  'openai',
  'elevenlabs',
  'gemini',
  'openrouter',
]
export function isCloudProvider(id: string): id is CloudVoiceProviderId {
  return (CLOUD_VOICE_PROVIDERS as readonly string[]).includes(id)
}
