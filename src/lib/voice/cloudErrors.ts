import { useProjectsStore } from '../../stores/projectsStore'
import type { CloudVoiceProviderId } from '../types'
export function forgetProviderKey(provider: CloudVoiceProviderId): void {
  const store = useProjectsStore.getState()
  store.setPreferences({
    voiceProviders: {
      ...store.preferences.voiceProviders,
      [provider]: { configured: false, invalid: false },
    },
  })
}
