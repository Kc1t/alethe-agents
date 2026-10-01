import { useCallback, useEffect, useState } from 'react'

import type { InstallToolchain } from '../lib/agentInstall'
import { router9HasInstall, router9ResolveSource } from '../lib/router9'
import {
  probeInstallToolchain,
  router9Start,
  type Router9Status,
  router9Status,
  router9Stop,
} from '../lib/tauri'
import { DEFAULT_ROUTER9_PREFERENCES } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'

/** Shared read of the local proxy's state, plus the two controls every surface needs. */
export function useRouter9Runtime(active = true) {
  const config = useProjectsStore(
    (state) => state.preferences.router9 ?? DEFAULT_ROUTER9_PREFERENCES,
  )
  const [status, setStatus] = useState<Router9Status | null>(null)
  const [toolchain, setToolchain] = useState<InstallToolchain | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!active) return
    const [next, tools] = await Promise.all([
      router9Status(config.port).catch(() => null),
      probeInstallToolchain().catch(() => null),
    ])
    setStatus(next)
    setToolchain(tools)
  }, [active, config.port])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const resolved = router9ResolveSource(status, config.source)

  const start = useCallback(async () => {
    setBusy(true)
    try {
      await router9Start(config.port, resolved?.source ?? config.source)
    } finally {
      setBusy(false)
      await refresh()
    }
  }, [config.port, config.source, refresh, resolved?.source])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await router9Stop()
    } finally {
      setBusy(false)
      await refresh()
    }
  }, [refresh])

  return {
    config,
    status,
    toolchain,
    resolved,
    hasInstall: router9HasInstall(status),
    busy,
    refresh,
    start,
    stop,
  }
}
