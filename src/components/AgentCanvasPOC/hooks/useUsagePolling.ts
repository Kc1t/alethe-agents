import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'

import { USAGE_FALLBACK_THRESHOLD, USAGE_POLL_MS } from '../../../lib/agentCanvasConfig'
import { formatReset } from '../../../lib/agentCanvasUtils'
import { getCachedClaudeUsage } from '../../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../../lib/codexUsageCache'
import { type ClaudeUsage, type CodexUsage, writePty } from '../../../lib/tauri'

type Session = { folder: string; ptyId: string }

   
                                                                             
                                                                           
                                                                         
   
export function useUsagePolling(
  session: Session | null,
  sessionRef: MutableRefObject<Session | null>,
  hooksEndpoint: string | null,
) {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null)
  const [fallbackActive, setFallbackActive] = useState(false)
  const fallbackActiveRef = useRef(false)
  const leadNotifiedRef = useRef(false)

                                                                          
                                                                             
                                                                        
                                                                            
                                        
  const activateFallback = useCallback(
    (u: ClaudeUsage | null, forced = false) => {
      if (fallbackActiveRef.current) return
      fallbackActiveRef.current = true
      setFallbackActive(true)
      const pct = u ? Math.round(u.five_hour.utilization) : 0
      console.log(`[AgentCanvasPOC] FALLBACK codex ON${forced ? ' (forçado)' : ''} — 5h ${pct}%`)
      if (!leadNotifiedRef.current && sessionRef.current) {
        leadNotifiedRef.current = true
        const reset = u ? formatReset(u.five_hour.resets_at) : '—'
                                                                                
                                                                                     
        const endpoint = hooksEndpoint ?? 'http://127.0.0.1:9123'
        const note = `[Alethe] Claude 5h usage at ${pct}% (resets in ${reset}). Conserve Claude tokens: from now on, offload heavy/long/mechanical work to the codex terminal by running: curl -s -X POST ${endpoint}/codex -d "<task as one self-contained English instruction>". It runs in the codex terminal worker shown in the canvas. `
        void writePty(sessionRef.current.ptyId, note).catch(() => {})
      }
    },
    [hooksEndpoint, sessionRef],
  )

                                                                              
  useEffect(() => {
    if (!session) return
    let cancelled = false

    const check = async () => {
      try {
        const u = await getCachedClaudeUsage()
        if (cancelled) return
        setUsage(u)
        const util = u.five_hour.utilization
        if (util >= USAGE_FALLBACK_THRESHOLD) {
          activateFallback(u)
        } else if (fallbackActiveRef.current) {
                                                                               
          fallbackActiveRef.current = false
          setFallbackActive(false)
          console.log('[AgentCanvasPOC] fallback codex OFF — usage voltou a', util)
        }
      } catch (err) {
        console.warn('[AgentCanvasPOC] usage indisponível (sem token?):', err)
      }
                                                                             
      try {
        const cu = await getCachedCodexUsage()
        if (!cancelled) setCodexUsage(cu)
      } catch {
        if (!cancelled) setCodexUsage(null)
      }
    }

    void check()
    const timer = window.setInterval(check, USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session, activateFallback])

  return { usage, codexUsage, fallbackActive, activateFallback }
}
