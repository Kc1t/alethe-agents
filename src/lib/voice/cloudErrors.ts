import { useProjectsStore } from '../../stores/projectsStore'
import type { MessageKey } from '../i18n'
import type { CloudErrorKind } from '../tauri/voiceProviders'
import type { CloudVoiceProviderId } from '../types'
import { isCloudProvider } from './providers'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

const KINDS: readonly CloudErrorKind[] = [
  'network',
  'auth',
  'quota',
  'badAudio',
  'timeout',
  'other',
]

/** The error class of a Rust cloud error (`voice_cloud_<kind>` or `voice_cloud_<kind> (HTTP n)`). */
export function parseCloudError(cause: unknown): CloudErrorKind | null {
  const text = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const kind = /^voice_cloud_(\w+)/.exec(text)?.[1]
  return KINDS.find((known) => known === kind) ?? null
}

/** Flags a saved key the provider rejected. A provider without a key stays unconfigured. */
export function markKeyInvalid(provider: CloudVoiceProviderId): void {
  const store = useProjectsStore.getState()
  const current = store.preferences.voiceProviders[provider]
  if (!current?.configured || current.invalid) return
  store.setPreferences({
    voiceProviders: {
      ...store.preferences.voiceProviders,
      [provider]: { ...current, invalid: true },
    },
  })
}

/**
 * The message for a cloud speech failure no local engine could take over, or null when `cause`
 * is not one. A rejected key also marks the provider invalid.
 */
export function cloudFailureMessage(cause: unknown, provider: string, t: Translate): string | null {
  const kind = parseCloudError(cause)
  if (!kind || !isCloudProvider(provider)) return null
  if (kind === 'auth') markKeyInvalid(provider)
  const title = t('voice.fallback.title', { provider: t(`voice.provider.${provider}`) })
  return `${title} — ${t(`prefs.voiceTestFailed.${kind}`)}`
}
