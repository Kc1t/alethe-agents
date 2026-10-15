import { useEffect } from 'react'

import { voiceProvidersStatus } from '../lib/tauri'
import { CLOUD_VOICE_PROVIDERS } from '../lib/voice/providers'
import { clearProviderUses, flagsFromStatus } from '../lib/voice/voicePreferences'
import { useProjectsStore } from '../stores/projectsStore'

/** Keys live in the keychain per profile; mirror which exist so the UI and sanitizer can see it. */
export function useVoiceProviderStatus(hydrated: boolean, activeProfileId: string): void {
  useEffect(() => {
    if (!hydrated) return
    let cancelled = false
    void voiceProvidersStatus()
      .then((statuses) => {
        if (cancelled) return
        const store = useProjectsStore.getState()
        const flags = flagsFromStatus(statuses, store.preferences.voiceProviders)
        let uses: ReturnType<typeof clearProviderUses> = store.preferences
        for (const provider of CLOUD_VOICE_PROVIDERS) {
          if (!flags[provider]?.configured) uses = clearProviderUses(uses, provider)
        }
        store.setPreferences({
          voiceProviders: flags,
          voiceStt: uses.voiceStt,
          voiceTts: uses.voiceTts,
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hydrated, activeProfileId])
}
