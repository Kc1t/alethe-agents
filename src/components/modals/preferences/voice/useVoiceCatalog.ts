import { useCallback, useEffect, useState } from 'react'

import {
  voiceOpenrouterModels,
  type VoiceProviderCatalog,
  voiceProviderCatalog,
} from '../../../../lib/tauri'

export type VoiceCatalogState = {
  catalog: VoiceProviderCatalog[]
  failed: boolean
  retry: () => void
}

export function useVoiceCatalog(enabled = true, liveModels = true): VoiceCatalogState {
  const [catalog, setCatalog] = useState<VoiceProviderCatalog[]>([])
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      setFailed(false)
      let list: VoiceProviderCatalog[]
      try {
        list = await voiceProviderCatalog()
      } catch {
        if (!cancelled) setFailed(true)
        return
      }
      if (cancelled) return
      setCatalog(list)
      if (!liveModels) return
      const live = await Promise.all([
        voiceOpenrouterModels('stt'),
        voiceOpenrouterModels('tts'),
      ]).catch(() => null)
      if (cancelled || !live) return
      const [liveStt, liveTts] = live
      setCatalog(
        list.map((entry) => {
          if (entry.provider !== 'openrouter') return entry
          const curated = (kind: 'stt' | 'tts') => entry.models.filter((m) => m.capability === kind)
          return {
            ...entry,
            models: [
              ...(liveStt.length > 0 ? liveStt : curated('stt')),
              ...(liveTts.length > 0 ? liveTts : curated('tts')),
            ],
          }
        }),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [attempt, enabled, liveModels])

  return { catalog, failed, retry }
}
