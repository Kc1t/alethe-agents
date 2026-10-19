import { useProjectsStore } from '../../stores/projectsStore'
import { voiceProviderSetKey } from '../tauri/voiceProviders'

/** Jev routes through OpenRouter's decisions endpoint, so it shares the OpenRouter voice key. */
export const JEV_KEY_PROVIDER = 'openrouter' as const

export function isJevKeyConfigured(
  flags: ReturnType<typeof useProjectsStore.getState>['preferences']['voiceProviders'],
): boolean {
  return flags[JEV_KEY_PROVIDER]?.configured === true
}

function markConfigured(): void {
  const store = useProjectsStore.getState()
  store.setPreferences({
    voiceProviders: {
      ...store.preferences.voiceProviders,
      [JEV_KEY_PROVIDER]: { configured: true, invalid: false },
    },
  })
}

/** Saves the key the Jev bar asked for into the OS keychain, as the OpenRouter key. */
export async function saveJevKey(key: string): Promise<void> {
  await voiceProviderSetKey(JEV_KEY_PROVIDER, key.trim())
  markConfigured()
}

/**
 * Moves the plaintext key older versions kept in preferences into the keychain, once. A key the
 * keychain already has wins: both are OpenRouter keys. A keychain failure keeps the plaintext key
 * for the next start; a key the keychain refuses as malformed could never work and is dropped.
 */
export async function migrateLegacyJevKey(): Promise<void> {
  const { preferences } = useProjectsStore.getState()
  const legacy = preferences.voiceCommandApiKey.trim()
  if (!legacy) return
  if (!isJevKeyConfigured(preferences.voiceProviders)) {
    try {
      await saveJevKey(legacy)
    } catch (cause) {
      if (!String(cause).includes('voice_key_invalid_format')) return
    }
  }
  useProjectsStore.getState().setPreferences({ voiceCommandApiKey: '' })
}
