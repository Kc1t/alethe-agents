import {
  AudioWaveform,
  Gem,
  HardDrive,
  Laptop,
  type LucideIcon,
  Route,
  Server,
  Sparkle,
  Volume2,
} from 'lucide-react'

import type { MessageKey } from '../../../../lib/i18n/messages/en'
import type { CloudVoiceProviderId, VoiceProviderFlags } from '../../../../lib/types'
import type { ProviderStatus } from './ProviderCard'

export type VoiceProviderId = 'local' | 'apple' | 'system' | 'server' | CloudVoiceProviderId

type Meta = {
  icon: LucideIcon
  name: MessageKey
  description: MessageKey
  group: 'local' | 'cloud' | 'server'
}

export const PROVIDER_META: Record<VoiceProviderId, Meta> = {
  local: {
    icon: HardDrive,
    name: 'voice.provider.local',
    description: 'prefs.voiceProviderLocalDesc',
    group: 'local',
  },
  apple: {
    icon: Laptop,
    name: 'voice.provider.apple',
    description: 'prefs.voiceProviderAppleDesc',
    group: 'local',
  },
  system: {
    icon: Volume2,
    name: 'voice.provider.system',
    description: 'prefs.voiceProviderSystemDesc',
    group: 'local',
  },
  server: {
    icon: Server,
    name: 'voice.provider.server',
    description: 'prefs.voiceProviderServerDesc',
    group: 'server',
  },
  openai: {
    icon: Sparkle,
    name: 'voice.provider.openai',
    description: 'prefs.voiceProviderOpenaiDesc',
    group: 'cloud',
  },
  elevenlabs: {
    icon: AudioWaveform,
    name: 'voice.provider.elevenlabs',
    description: 'prefs.voiceProviderElevenlabsDesc',
    group: 'cloud',
  },
  gemini: {
    icon: Gem,
    name: 'voice.provider.gemini',
    description: 'prefs.voiceProviderGeminiDesc',
    group: 'cloud',
  },
  openrouter: {
    icon: Route,
    name: 'voice.provider.openrouter',
    description: 'prefs.voiceProviderOpenrouterDesc',
    group: 'cloud',
  },
}

/** Connection state of a cloud provider from its saved key flags. */
export function cloudStatus(flag: VoiceProviderFlags[CloudVoiceProviderId]): ProviderStatus {
  if (!flag?.configured) return 'disconnected'
  return flag.invalid ? 'invalid' : 'connected'
}
