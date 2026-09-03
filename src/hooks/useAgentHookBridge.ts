import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'

import { type AgentHookPayload, useAgentCanvasStore } from '../stores/agentCanvasStore'

/**
 * Feeds `agentCanvasStore` from the app's own subagent hooks (SubagentStart/Stop, PreToolUse,
 * agent_events.rs) regardless of which pane is open — without this mounted somewhere always-on, the
 * orchestrator board's native-subagent branch never fills in outside the AgentCanvasPOC pane, since
 * that pane owned the only other listener for this event.
 */
export function useAgentHookBridge(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen<AgentHookPayload>('agent-hook', (event) => {
      useAgentCanvasStore.getState().ingest(event.payload)
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
