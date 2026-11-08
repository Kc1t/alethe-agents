import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { useProjectsStore } from '../stores/projectsStore'

const RELOAD_THROTTLE_MS = 1_000

// Secondary windows read the profile once, then once per burst of main-window saves.
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
