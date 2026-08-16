import { useEffect, useRef } from 'react'

import { mcpScan } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

/**
 * Offers the MCP setup once, and only to someone who actually has an agent configured —
 * never stacking on top of another modal.
 */
export function useMcpIntroPrompt() {
  const hydrated = useProjectsStore((state) => state.hydrated)
  const onboardingDone = useProjectsStore((state) => state.preferences.onboardingDone)
  const seen = useProjectsStore((state) => state.preferences.mcpOnboardingSeen)
  const enabled = useProjectsStore((state) => state.preferences.enabledFeatures.mcp)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const openModal = useUiStore((state) => state.openModal)
  const open = useUiStore((state) => state.openModal_)
  const firedRef = useRef(false)

  useEffect(() => {
    if (firedRef.current) return
    if (!hydrated || !onboardingDone || seen || !enabled) return
    if (openModal !== null) return
    firedRef.current = true

    void mcpScan('global')
      .then((snapshots) => {
        const configured = snapshots.some((snapshot) =>
          snapshot.sources.some((source) => source.exists),
        )
        if (configured) open('mcpIntro')
        else setPreferences({ mcpOnboardingSeen: true })
      })
      .catch(() => {
        firedRef.current = false
      })
  }, [hydrated, onboardingDone, seen, enabled, openModal, open, setPreferences])
}
