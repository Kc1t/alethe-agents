import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isSessionClaimed,
  registerSessionClaim,
  resetSessionClaimsForTests,
} from '../lib/sessionDiscovery'
import { buildAgentLaunch } from '../lib/sessionLaunch'
import { peekSession, savedConversationIdFor } from '../lib/sessionResume'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import type { AgentHookPayload } from '../stores/agentCanvasStore'
import { useProjectsStore } from '../stores/projectsStore'
import { migrate } from '../stores/projectsStore.migrations'
import { useAgentHookBridge } from './useAgentHookBridge'

const events = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: { payload: AgentHookPayload }) => void),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name, handler) => {
    events.handler = handler
    return () => {
      events.handler = undefined
    }
  }),
}))

const state = () => useProjectsStore.getState()
const tabs = () => state().projects[0].terminals.map((terminal) => terminal.tabs[0])

beforeEach(() => {
  localStorage.clear()
  resetSessionClaimsForTests()
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
  const project = state().createProject({ name: 'Four Claude panes' })
  for (let index = 0; index < 4; index++) {
    const terminal = state().createTerminal(project.id, {
      name: `Claude ${index}`,
      cwd: 'D:/repo',
      firstTab: { type: 'claude', cwd: 'D:/repo' },
    })
    const tab = terminal.tabs[0]
    state().setSubTabSessionId(project.id, terminal.id, tab.id, `chat-${index}`)
    state().setSubTabPtyId(project.id, terminal.id, tab.id, `pty-${index}`)
    registerSessionClaim('claude', 'D:/repo', `chat-${index}`, tab.id)
    registerSessionClaim('claude', 'D:/repo', `chat-${index}`, `pty-${index}`)
  }
})

async function mountBridge() {
  const hook = renderHook(() => useAgentHookBridge())
  await waitFor(() => expect(events.handler).toBeDefined())
  return hook
}

function emit(plannerId: string, sessionId: string, hookEvent = 'SessionStart') {
  act(() =>
    events.handler?.({
      payload: {
        plannerId,
        session_id: sessionId,
        hook_event_name: hookEvent,
        sourceAgent: 'claude',
      },
    }),
  )
}

describe('Claude session persistence across terminal views', () => {
  it('restores four distinct conversations after /new in a pane with no mounted terminal view', async () => {
    const hook = await mountBridge()
    emit('pty-0', 'bananas')
    emit('pty-0', 'new-chat')
    emit('pty-1', 'chat-1', 'UserPromptSubmit')
    emit('pty-2', 'chat-2', 'UserPromptSubmit')
    emit('pty-3', 'chat-3', 'UserPromptSubmit')
    expect(tabs().map((tab) => tab.sessionId)).toEqual(['new-chat', 'chat-1', 'chat-2', 'chat-3'])
    const file = migrate(JSON.parse(JSON.stringify(state())))
    hook.unmount()
    resetSessionClaimsForTests()
    useProjectsStore.setState({ ...file, hydrated: false })
    const restored = tabs().map((tab) => {
      const id = savedConversationIdFor(peekSession(tab.id), tab.type, tab.cwd) ?? tab.sessionId
      return buildAgentLaunch('claude', [], id).args
    })
    expect(restored).toEqual(
      ['new-chat', 'chat-1', 'chat-2', 'chat-3'].map((id) => ['--resume', id]),
    )
  })

  it('persists a new empty conversation immediately and hands off both session claims', async () => {
    await mountBridge()
    emit('pty-0', 'empty-new-chat')
    expect(peekSession(tabs()[0].id)?.claudeSessionId).toBe('empty-new-chat')
    expect(isSessionClaimed('claude', 'D:\\repo\\', 'chat-0')).toBe(false)
    expect(isSessionClaimed('claude', 'D:\\repo\\', 'empty-new-chat', tabs()[1].id)).toBe(true)
    expect(isSessionClaimed('claude', 'D:/repo', 'chat-1')).toBe(true)
  })

  it('tracks repeated switches and /resume back to the original conversation', async () => {
    await mountBridge()
    emit('pty-0', 'new-a')
    emit('pty-1', 'new-b')
    emit('pty-0', 'chat-0')
    expect(tabs().map((tab) => tab.sessionId)).toEqual(['chat-0', 'new-b', 'chat-2', 'chat-3'])
    expect(peekSession(tabs()[0].id)?.claudeSessionId).toBe('chat-0')
  })

  it('ignores other providers, subagent events, and events from a replaced PTY', async () => {
    await mountBridge()
    emit('old-pty-0', 'wrong')
    emit('pty-0', 'wrong', 'SubagentStart')
    act(() =>
      events.handler?.({
        payload: {
          plannerId: 'pty-0',
          sourceAgent: 'codex',
          session_id: 'wrong',
          hook_event_name: 'SessionStart',
        },
      }),
    )
    expect(tabs()[0].sessionId).toBe('chat-0')
    expect(peekSession(tabs()[0].id)).toBeNull()
  })
})
