import { useEffect } from 'react'

import { useT } from '../lib/i18n'
import type { MessageKey } from '../lib/i18n/messages/en'
import { onVoiceFallback } from '../lib/tauri'
import { markKeyInvalid } from '../lib/voice/cloudErrors'
import { isCloudProvider } from '../lib/voice/providers'
import { useUiStore } from '../stores/uiStore'

const ENGINE_NAME: Record<string, MessageKey> = {
  'apple-speech': 'voice.provider.apple',
  system: 'voice.provider.system',
}

/** Tells the person when a cloud voice provider failed and which local engine took over. */
export function useVoiceFallbackToasts(): void {
  const t = useT()
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onVoiceFallback((event) => {
      const provider = t(`voice.provider.${event.provider}` as MessageKey)
      const engineKey = ENGINE_NAME[event.fallback] ?? 'voice.provider.local'
      useUiStore.getState().pushToast({
        title: t('voice.fallback.title', { provider }),
        body: `${t(`prefs.voiceTestFailed.${event.reason}` as MessageKey)} ${t('voice.fallback.used', { engine: t(engineKey) })}`,
      })
      if (event.reason === 'auth' && isCloudProvider(event.provider)) markKeyInvalid(event.provider)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [t])
}
