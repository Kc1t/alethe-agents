import type { AgentHookPayload } from '../stores/agentCanvasStore'
import { useProjectsStore } from '../stores/projectsStore'
import { registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { conversationFields, saveSession } from './sessionResume'
import { recordAppEvent } from './tauri/misc'

export type HookTrackedAgent = 'claude' | 'antigravity'

export function shortSessionId(sessionId: string | undefined): string {
  return sessionId ? sessionId.slice(0, 8) : 'none'
}

export function hookSessionForAgent(
  payload: AgentHookPayload,
  expectedAgent: HookTrackedAgent = 'claude',
): string | undefined {
  const source = payload.sourceAgent ?? 'claude'
  if (source !== expectedAgent) return undefined
  if (payload.agent_id) return undefined
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

export function claudeSessionFromHook(payload: AgentHookPayload): string | undefined {
  return hookSessionForAgent(payload, 'claude')
}

/** Track inactive tabs too: their PTYs keep running after their terminal views unmount. */
export function trackClaudeSessionHook(payload: AgentHookPayload): void {
  const agent = payload.sourceAgent ?? 'claude'
  if (agent !== 'claude' && agent !== 'antigravity') return
  const sessionId = hookSessionForAgent(payload, agent)
  if (!sessionId || !payload.plannerId) return
  const state = useProjectsStore.getState()
  for (const project of state.projects) {
    for (const terminal of project.terminals) {
      if (terminal.gsdSyncViewer) continue
      for (const tab of terminal.tabs) {
        const ptyId = tab.ptyId ?? tab.id
        if (tab.type !== agent || ptyId !== payload.plannerId) continue
        const cwd = tab.cwd ?? terminal.cwd ?? ''
        releaseSessionClaim(tab.id)
        releaseSessionClaim(ptyId)
        registerSessionClaim(agent, cwd, sessionId, tab.id)
        registerSessionClaim(agent, cwd, sessionId, ptyId)
        // Save immediately as well as updating the debounced projects file.
        saveSession(tab.id, {
          sessionId: ptyId,
          ...conversationFields(agent, sessionId),
          agent,
          cwd,
          timestamp: Date.now(),
        })
        if (tab.sessionId !== sessionId) {
          state.setSubTabSessionId(project.id, terminal.id, tab.id, sessionId)
          void recordAppEvent(
            'session.adopt',
            `agent=${agent} via=${payload.hook_event_name} from=${shortSessionId(tab.sessionId)} to=${shortSessionId(sessionId)}`,
          )
        }
        return
      }
    }
  }
}
