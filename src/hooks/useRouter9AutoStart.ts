import { useEffect, useRef } from 'react'

import { router9ResolveSource } from '../lib/router9'
import { router9Start, router9Status } from '../lib/tauri'
import { DEFAULT_ROUTER9_PREFERENCES } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'

/** Starts the local proxy once per launch, and only when the user asked for it in Preferences. */
export function useRouter9AutoStart(hydrated: boolean): void {
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (!hydrated || attemptedRef.current) return
    const config = useProjectsStore.getState().preferences.router9 ?? DEFAULT_ROUTER9_PREFERENCES
    if (!config.enabled || !config.autoStart) return
    attemptedRef.current = true

    void router9Status(config.port)
      .then((status) => {
        const resolved = router9ResolveSource(status, config.source)
        if (!resolved || status.running || status.portInUse) return
        return router9Start(config.port, resolved.source)
      })
      .catch(() => undefined)
  }, [hydrated])
}
