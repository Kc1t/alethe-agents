import type { MessageKey } from '../i18n'
import { HUB_ERROR, type HubFamily, type HubModelInfo } from '../tauri'
import type { ModelInfo, ModelUse, Tier } from './modelInfo'

const FAMILY_TEXT: Record<HubFamily, { summary: MessageKey; details: MessageKey }> = {
  vits: { summary: 'voice.family.vits.summary', details: 'voice.family.vits.details' },
  kokoro: { summary: 'voice.family.kokoro.summary', details: 'voice.family.kokoro.details' },
  kitten: { summary: 'voice.family.kitten.summary', details: 'voice.family.kitten.details' },
  transducer: {
    summary: 'voice.family.transducer.summary',
    details: 'voice.family.transducer.details',
  },
  'nemo-transducer': {
    summary: 'voice.family.nemoTransducer.summary',
    details: 'voice.family.nemoTransducer.details',
  },
  whisper: { summary: 'voice.family.whisper.summary', details: 'voice.family.whisper.details' },
  moonshine: {
    summary: 'voice.family.moonshine.summary',
    details: 'voice.family.moonshine.details',
  },
  'sense-voice': {
    summary: 'voice.family.senseVoice.summary',
    details: 'voice.family.senseVoice.details',
  },
  paraformer: {
    summary: 'voice.family.paraformer.summary',
    details: 'voice.family.paraformer.details',
  },
  'nemo-ctc': { summary: 'voice.family.nemoCtc.summary', details: 'voice.family.nemoCtc.details' },
  dolphin: { summary: 'voice.family.dolphin.summary', details: 'voice.family.dolphin.details' },
}

/**
 * Curated tiers for popular repos (spec §6); they replace the estimates. Only these can carry the
 * Recommended badge.
 */
const HUB_OVERRIDES: Record<string, Pick<ModelInfo, 'speed' | 'accuracy' | 'recommended'>> = {
  'hf:csukuangfj/kokoro-multi-lang-v1_0': { speed: 2, accuracy: 3, recommended: true },
  'hf:csukuangfj/vits-piper-pt_BR-cadu-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/vits-piper-pt_BR-jeff-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/vits-piper-pt_BR-faber-medium': { speed: 3, accuracy: 2 },
  'hf:csukuangfj/sherpa-onnx-whisper-turbo': { speed: 2, accuracy: 3, recommended: true },
  'hf:csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17': { speed: 3, accuracy: 2 },
}

const tier = (value: number | null): Tier | undefined =>
  value === 1 || value === 2 || value === 3 ? value : undefined

export function hubSourceUrl(repo: string): string {
  return `https://huggingface.co/${repo}`
}

export function hubModelInfo(id: string, use: ModelUse, hub: HubModelInfo): ModelInfo {
  const override = HUB_OVERRIDES[id]
  return {
    id,
    use,
    languages: hub.languages,
    languageCount: hub.languageCount ?? undefined,
    multilingual: hub.multilingual,
    speed: override?.speed ?? tier(hub.speed),
    accuracy: override?.accuracy ?? tier(hub.accuracy),
    estimated: override === undefined,
    recommended: override?.recommended,
    voiceCount: hub.voiceCount ?? undefined,
    ...FAMILY_TEXT[hub.family],
    sourceUrl: hubSourceUrl(hub.repo),
  }
}

const ERROR_KEYS: Record<string, MessageKey> = {
  [HUB_ERROR.offline]: 'prefs.voiceHubOffline',
  [HUB_ERROR.rateLimited]: 'prefs.voiceHubRateLimited',
  [HUB_ERROR.unavailable]: 'prefs.voiceHubFailed',
  [HUB_ERROR.badResponse]: 'prefs.voiceHubFailed',
  [HUB_ERROR.incompatible]: 'prefs.voiceHubIncompatible',
  [HUB_ERROR.tooLarge]: 'prefs.voiceHubTooLarge',
  [HUB_ERROR.gated]: 'prefs.voiceHubUnavailable',
  [HUB_ERROR.unknownRepo]: 'prefs.voiceHubUnavailable',
}

/** The message for a Hugging Face rejection code; `null` for anything else. */
export function hubErrorKey(message: string): MessageKey | null {
  return ERROR_KEYS[message.trim()] ?? null
}
