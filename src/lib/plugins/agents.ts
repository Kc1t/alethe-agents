import { pluginInvoke } from '../tauri'
import { trackedListen } from './listen'
import { pluginAgents } from './presentation'
import { liveSessionIdOf, locateSession } from './terminals'
import type {
  AgentHookEvent,
  AgentPermissionReleased,
  AgentTranscript,
  AgentTranscriptMessage,
  Disposable,
  PluginAgents,
} from './types'

export const HOOK_EVENT = 'agent-hook'
export const PERMISSION_RELEASED_EVENT = 'agent-permission://released'
const TRANSCRIPT_AGENTS = new Set(['claude', 'codex'])

type RawHook = { plannerId?: unknown; hook_event_name?: unknown; [field: string]: unknown }

type RawTranscript = {
  sessionId: string | null
  revision: number
  unchanged: boolean
  firstIndex: number
  messages: AgentTranscriptMessage[]
}

export function createPluginAgents(
  require: (capability: string) => void,
  subscriptions: Disposable[],
): PluginAgents {
  return {
    ...pluginAgents,
    onHook: (handler) => {
      require('agent.observe')
      return trackedListen<RawHook>(subscriptions, HOOK_EVENT, (payload) => {
        const { plannerId, ...rest } = payload
        if (typeof plannerId !== 'string' || typeof rest.hook_event_name !== 'string') return
        const sessionId = liveSessionIdOf(plannerId)
        if (!sessionId) return
        handler({ ...rest, sessionId } as AgentHookEvent)
      })
    },
    transcript: async (sessionId, cursor) => {
      require('agent.observe')
      const { tab, terminal } = locateSession(sessionId)
      if (!TRANSCRIPT_AGENTS.has(String(tab.type))) {
        throw new Error(`transcript_unsupported:${tab.type}`)
      }
      const raw = await pluginInvoke<RawTranscript>('agent_transcript_snapshot', {
        provider: tab.type,
        cwd: tab.cwd || terminal.cwd,
        sessionId: tab.sessionId ?? null,
        since: cursor ?? null,
      })
      const { sessionId: conversationId, ...snapshot } = raw
      return { conversationId, ...snapshot } satisfies AgentTranscript
    },
    decidePermission: async (requestId, behavior, message) => {
      require('agent.approve')
      await pluginInvoke('agent_permission_decide', { requestId, behavior, message })
    },
    onPermissionReleased: (handler) => {
      require('agent.approve')
      return trackedListen<AgentPermissionReleased>(
        subscriptions,
        PERMISSION_RELEASED_EVENT,
        ({ requestId, reason }) => handler({ requestId, reason }),
      )
    },
  }
}
