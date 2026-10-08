import { useEffect, useRef } from 'react'

import { AI_MEMORY_DEFAULT_PORT, aiMemoryStart, canStart } from '../lib/aiMemory'
import { aiMemoryDetect } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'

/**
 * Starts ai-memory's server once per launch, mirroring `useRouter9AutoStart`: both halves of the
 * feature need it running — the capture hooks POST to it, and the MCP registration points at it —
 * so leaving it off until someone opens Preferences and clicks Start meant the feature was off again
 * on every launch.
 */
export function useAiMemoryAutoStart(hydrated: boolean): void {
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (!hydrated || attemptedRef.current) return
    const enabled = useProjectsStore.getState().preferences.enabledFeatures.aiMemory
    if (!enabled) return
    attemptedRef.current = true

    void aiMemoryDetect()
      .then((status) => {
        // `canStart` is also what the panel uses to decide whether to offer the button: installed,
        // and nothing already answering on the endpoint — including someone's own copy, which this
        // must leave alone rather than fight for the bind.
        if (!canStart(status)) return
        return aiMemoryStart(AI_MEMORY_DEFAULT_PORT)
      })
      .catch(() => undefined)
  }, [hydrated])
}
