import { useCallback, useEffect, useState } from 'react'

import {
  speechListModels,
  type SpeechModelManifest,
  type SpeechModelState,
  speechModelStates,
} from '../../../../lib/tauri'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'

/** Speech model catalog and readiness, shared by the voice cards and the local model list. */
export function useSpeechInventory(locale: string | null = null) {
  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    let catalog: SpeechModelManifest[]
    let list: SpeechModelState[]
    try {
      ;[catalog, list] = await Promise.all([speechListModels(), speechModelStates(locale)])
    } catch (cause) {
      setFailed(true)
      throw cause
    }
    setFailed(false)
    rememberHubModels(catalog)
    setModels(catalog)
    setStates(Object.fromEntries(list.map((state) => [state.id, state])))
  }, [locale])

  const retry = useCallback(() => void refresh().catch(() => undefined), [refresh])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  /** `failed`: the last read was rejected; `retry` reads again. */
  return { models, states, refresh, failed, retry }
}
