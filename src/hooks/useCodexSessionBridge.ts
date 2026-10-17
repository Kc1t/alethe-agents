import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { type CodexRollout, trackCodexRollout } from '../lib/codexSessionTracking'

type SessionWatchPayload = { agent?: string; session?: CodexRollout }

export function useCodexSessionBridge(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<SessionWatchPayload>('session://new', (event) => {
      if (cancelled || event.payload?.agent !== 'codex' || !event.payload.session) return
      trackCodexRollout(event.payload.session)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
}
