import { useCallback, useEffect, useState } from 'react'

import { PLUGIN_API_VERSION } from '../../lib/plugins'
import { type CatalogPlugin, pluginCatalog } from '../../lib/tauri'

export type CatalogState = {
  entries: readonly CatalogPlugin[]
  loading: boolean
  stale: boolean
  failed: boolean
  reload: (refresh: boolean) => Promise<void>
}

export function useCatalog(): CatalogState {
  const [entries, setEntries] = useState<readonly CatalogPlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [stale, setStale] = useState(false)
  const [failed, setFailed] = useState(false)

  const reload = useCallback(async (refresh: boolean) => {
    setLoading(true)
    try {
      const snapshot = await pluginCatalog(PLUGIN_API_VERSION, refresh)
      setEntries(snapshot.plugins)
      setStale(snapshot.stale)
      setFailed(false)
    } catch {
      setEntries([])
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(false)
  }, [reload])

  return { entries, loading, stale, failed, reload }
}
