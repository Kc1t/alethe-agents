import type { AgentHookPayload } from '../stores/agentCanvasStore'
import { useProjectsStore } from '../stores/projectsStore'
import { registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { saveSession } from './sessionResume'

export function claudeSessionFromHook(payload: AgentHookPayload): string | undefined {
  if (payload.sourceAgent && payload.sourceAgent !== 'claude') return undefined
  if (
    payload.hook_event_name !== 'SessionStart' &&
    payload.hook_event_name !== 'UserPromptSubmit'
  ) {
    return undefined
  }
  return typeof payload.session_id === 'string' && payload.session_id.trim()
    ? payload.session_id
    : undefined
}

/** Track inactive tabs too: their PTYs keep running after their terminal views unmount. */
export function trackClaudeSessionHook(payload: AgentHookPayload): void {
  const sessionId = claudeSessionFromHook(payload)
  if (!sessionId || !payload.plannerId) return
  const state = useProjectsStore.getState()
  for (const project of state.projects) {
    for (const terminal of project.terminals) {
      if (terminal.gsdSyncViewer) continue
      for (const tab of terminal.tabs) {
        const ptyId = tab.ptyId ?? tab.id
        if (tab.type !== 'claude' || ptyId !== payload.plannerId) continue
        const cwd = tab.cwd ?? terminal.cwd ?? ''
        releaseSessionClaim(tab.id)
        releaseSessionClaim(ptyId)
        registerSessionClaim('claude', cwd, sessionId, tab.id)
        registerSessionClaim('claude', cwd, sessionId, ptyId)
        // Save immediately as well as updating the debounced projects file.
        saveSession(tab.id, {
          sessionId: ptyId,
          claudeSessionId: sessionId,
          agent: 'claude',
          cwd,
          timestamp: Date.now(),
        })
        if (tab.sessionId !== sessionId) {
          state.setSubTabSessionId(project.id, terminal.id, tab.id, sessionId)
        }
        return
      }
    }
  }
}
