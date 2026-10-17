import { beforeEach, describe, expect, it } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import {
  type CodexPane,
  type CodexRollout,
  noteCodexPaneInput,
  onCodexSessionAdopted,
  pickCodexPaneForRollout,
  resetCodexSessionTrackingForTests,
  trackCodexRollout,
} from './codexSessionTracking'
import {
  isSessionClaimed,
  registerSessionClaim,
  resetSessionClaimsForTests,
} from './sessionDiscovery'
import { peekSession } from './sessionResume'
import { EMPTY_PROJECTS_FILE } from './types'

const NOW = 1_800_000_000_000
const SPAWNED_AT = NOW - 60_000

function pane(overrides: Partial<CodexPane> & { tabId: string }): CodexPane {
  return {
    projectId: 'project',
    terminalId: `terminal-${overrides.tabId}`,
    ptyId: `pty-${overrides.tabId}`,
    cwd: 'D:/repo',
    alive: true,
    spawnedAt: SPAWNED_AT,
    expectsNew: false,
    ...overrides,
  }
}

function rollout(overrides: Partial<CodexRollout> = {}): CodexRollout {
  return {
    id: 'rollout-new',
    cwd: 'D:\\repo',
    source: 'cli',
    started_at: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  }
}

describe('pickCodexPaneForRollout', () => {
  it('gives a pane without a conversation the only new interactive rollout', () => {
    const panes = [pane({ tabId: 'a' })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)?.tabId).toBe('a')
  })

  it.each([
    ['a codex exec run', { source: 'exec' }],
    ['an app-server thread', { source: 'vscode' }],
    ['a subagent thread', { source: null }],
  ])('ignores %s', (_label, overrides) => {
    const panes = [pane({ tabId: 'a' })]
    expect(pickCodexPaneForRollout(panes, rollout(overrides), NOW)).toBeUndefined()
  })

  it('ignores a rollout another pane already sits on', () => {
    const panes = [pane({ tabId: 'a' }), pane({ tabId: 'b', sessionId: 'rollout-new' })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)).toBeUndefined()
  })

  it('ignores a thread created before the pane process existed', () => {
    const panes = [pane({ tabId: 'a' })]
    const older = rollout({ started_at: new Date(SPAWNED_AT - 60_000).toISOString() })
    expect(pickCodexPaneForRollout(panes, older, NOW)).toBeUndefined()
  })

  it('ignores panes in another directory and panes whose process is gone', () => {
    const panes = [pane({ tabId: 'a', cwd: 'D:/other' }), pane({ tabId: 'b', alive: false })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)).toBeUndefined()
  })

  it('moves a pane that just submitted to its new conversation after /new', () => {
    const panes = [pane({ tabId: 'a', sessionId: 'first-chat', lastSubmitAt: NOW - 2_000 })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)?.tabId).toBe('a')
  })

  it('leaves a settled pane alone when a rollout appears without a recent submit', () => {
    const panes = [pane({ tabId: 'a', sessionId: 'first-chat', lastSubmitAt: NOW - 120_000 })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)).toBeUndefined()
  })

  it('prefers the pane that asked for a new conversation over a neighbour that also submitted', () => {
    const panes = [
      pane({ tabId: 'a', sessionId: 'chat-a', lastSubmitAt: NOW - 1_000 }),
      pane({ tabId: 'b', sessionId: 'chat-b', lastSubmitAt: NOW - 4_000, expectsNew: true }),
    ]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)?.tabId).toBe('b')
  })

  it('picks the latest submit when two panes in one directory both wait for a conversation', () => {
    const panes = [
      pane({ tabId: 'a', lastSubmitAt: NOW - 9_000 }),
      pane({ tabId: 'b', lastSubmitAt: NOW - 1_000 }),
    ]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)?.tabId).toBe('b')
  })

  it('does not guess between two waiting panes when neither submitted recently', () => {
    const panes = [pane({ tabId: 'a' }), pane({ tabId: 'b' })]
    expect(pickCodexPaneForRollout(panes, rollout(), NOW)).toBeUndefined()
  })
})

describe('trackCodexRollout', () => {
  const state = () => useProjectsStore.getState()
  const tabs = () => state().projects[0].terminals.map((terminal) => terminal.tabs[0])
  const liveRollout = (id: string): CodexRollout => ({
    id,
    cwd: 'D:\\repo',
    source: 'cli',
    started_at: new Date().toISOString(),
  })

  beforeEach(() => {
    localStorage.clear()
    resetSessionClaimsForTests()
    resetCodexSessionTrackingForTests()
    useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: false })
    useTerminalsStore.setState({ byPtyId: {} })
    const project = state().createProject({ name: 'Two Codex panes' })
    for (let index = 0; index < 2; index++) {
      const terminal = state().createTerminal(project.id, {
        name: `Codex ${index}`,
        cwd: 'D:/repo',
        firstTab: { type: 'codex', cwd: 'D:/repo' },
      })
      state().setSubTabPtyId(project.id, terminal.id, terminal.tabs[0].id, `pty-${index}`)
      useTerminalsStore.getState().registerPty(`pty-${index}`)
    }
  })

  it('assigns each pane the conversation its own prompt created', () => {
    noteCodexPaneInput('pty-0', 'first prompt')
    trackCodexRollout(liveRollout('chat-a'))
    noteCodexPaneInput('pty-1', 'second prompt')
    trackCodexRollout(liveRollout('chat-b'))

    expect(tabs().map((tab) => tab.sessionId)).toEqual(['chat-a', 'chat-b'])
    expect(peekSession(tabs()[0].id)?.codexSessionId).toBe('chat-a')
    expect(peekSession(tabs()[1].id)?.codexSessionId).toBe('chat-b')
  })

  it('follows /new and hands the previous conversation back', () => {
    noteCodexPaneInput('pty-0', 'first prompt')
    trackCodexRollout(liveRollout('chat-a'))
    const adopted: string[] = []
    onCodexSessionAdopted((ptyId, sessionId) => adopted.push(`${ptyId}:${sessionId}`))

    noteCodexPaneInput('pty-0', '/new')
    noteCodexPaneInput('pty-0', 'prompt in the new chat')
    trackCodexRollout(liveRollout('chat-a2'))

    expect(tabs()[0].sessionId).toBe('chat-a2')
    expect(adopted).toEqual(['pty-0:chat-a2'])
    expect(isSessionClaimed('codex', 'D:/repo', 'chat-a')).toBe(false)
    expect(isSessionClaimed('codex', 'D:/repo', 'chat-a2', tabs()[1].id)).toBe(true)
  })

  it('leaves both panes untouched for a codex exec run in their directory', () => {
    noteCodexPaneInput('pty-0', 'prompt')
    trackCodexRollout({ ...liveRollout('exec-run'), source: 'exec' })

    expect(tabs().map((tab) => tab.sessionId)).toEqual([undefined, undefined])
  })

  it('does not take a conversation a pane is already resuming', () => {
    registerSessionClaim('codex', 'D:/repo', 'chat-resuming', 'another-tab')
    noteCodexPaneInput('pty-0', 'prompt')
    trackCodexRollout(liveRollout('chat-resuming'))

    expect(tabs()[0].sessionId).toBeUndefined()
  })
})
