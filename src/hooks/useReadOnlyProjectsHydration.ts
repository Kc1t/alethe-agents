import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { useProjectsStore } from '../stores/projectsStore'

/** The main window saves in bursts while it is busy; one reload per burst is enough here. */
const RELOAD_THROTTLE_MS = 1_000

/**
 * For secondary windows that only read the profile: read once, then again after the main window
 * saves (unless `reloadOnSave` is off). A reload reads the whole file, so saves close together share
 * one.
 */
export function useReadOnlyProjectsHydration({
  reloadOnSave = true,
}: { reloadOnSave?: boolean } = {}) {
  const hydrate = useProjectsStore((s) => s.hydrate)
  useEffect(() => {
    void hydrate()
    if (!reloadOnSave) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const reload = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!cancelled) void hydrate()
      }, RELOAD_THROTTLE_MS)
    }
    void listen('projects://saved', reload).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      unlisten?.()
    }
  }, [hydrate, reloadOnSave])
}
