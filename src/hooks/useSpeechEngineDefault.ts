import { useEffect } from 'react'

import { PARAKEET_MODEL_ID, shouldSwitchToNative } from '../lib/speech/engine'
import { APPLE_SPEECH_MODEL_ID, speechListModels, speechModelStates } from '../lib/tauri'
import type { SttChoice } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'

/** Spec §5.3: once per profile, a Mac that never picked a model moves to the Apple engine. */
export function useSpeechEngineDefault(hydrated: boolean, activeProfileId: string): void {
  useEffect(() => {
    if (!hydrated) return
    const { preferences } = useProjectsStore.getState()
    if (preferences.speechEngineMigrated) return
    let cancelled = false
    void (async () => {
      try {
        const [models, states] = await Promise.all([speechListModels(), speechModelStates()])
        if (cancelled) return
        const current = useProjectsStore.getState().preferences
        const switchToNative = shouldSwitchToNative({
          migrated: current.speechEngineMigrated,
          modelId: current.voiceStt.dictation.model,
          nativeAvailable: models.some((model) => model.id === APPLE_SPEECH_MODEL_ID),
          parakeetReady: states.some(
            (state) => state.id === PARAKEET_MODEL_ID && state.status === 'ready',
          ),
        })
        const toNative = (choice: SttChoice): SttChoice =>
          choice.provider === 'local' && choice.model === PARAKEET_MODEL_ID
            ? { provider: 'apple', model: APPLE_SPEECH_MODEL_ID, locale: choice.locale }
            : choice
        useProjectsStore.getState().setPreferences(
          switchToNative
            ? {
                voiceStt: {
                  dictation: toNative(current.voiceStt.dictation),
                  conversation: toNative(current.voiceStt.conversation),
                },
                speechEngineMigrated: true,
              }
            : { speechEngineMigrated: true },
        )
      } catch {
        // Try again on the next launch.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [hydrated, activeProfileId])
}
