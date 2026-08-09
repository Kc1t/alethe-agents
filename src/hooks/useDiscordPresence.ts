import { useEffect } from 'react'

import { clearDiscordPresence, setDiscordPresence } from '../lib/tauri'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'

const STARTED_AT = Math.floor(Date.now() / 1000)
const REFRESH_INTERVAL_MS = 30_000

const VIEW_LABELS = {
  home: 'Viewing the dashboard',
  workspace: 'Managing terminals',
  agentCanvas: 'Orchestrating AI agents',
  agentSandbox: 'Testing agent orchestration',
} as const

export function useDiscordPresence() {
  const hydrated = useProjectsStore((store) => store.hydrated)
  const enabled = useProjectsStore((store) => store.preferences.discordRichPresenceEnabled)
  const activeView = useUiStore((store) => store.activeView)

  useEffect(() => {
    if (!hydrated) return

    if (!enabled) {
      void clearDiscordPresence().catch(() => undefined)
      return
    }

    const update = () => {
      void setDiscordPresence('Working with Alethe', VIEW_LABELS[activeView], STARTED_AT).catch(
        () => undefined,
      )
    }

    update()
    const interval = window.setInterval(update, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeView, enabled, hydrated])
}
