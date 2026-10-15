import { useCallback, useEffect, useState } from 'react'

import {
  speechListModels,
  type SpeechModelManifest,
  type SpeechModelState,
  speechModelStates,
} from '../../../../lib/tauri'

/** Speech model catalog and readiness, shared by the voice cards and the local model list. */
export function useSpeechInventory(locale: string | null = null) {
  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})

  const refresh = useCallback(async () => {
    const [catalog, list] = await Promise.all([speechListModels(), speechModelStates(locale)])
    setModels(catalog)
    setStates(Object.fromEntries(list.map((state) => [state.id, state])))
  }, [locale])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  return { models, states, refresh }
}
