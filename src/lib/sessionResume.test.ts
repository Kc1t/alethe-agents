import { beforeEach, describe, expect, it } from 'vitest'

import {
  consumeSession,
  getActiveSessions,
  removeSession,
  savedConversationIdFor,
  type SavedSession,
  saveSession,
} from './sessionResume'
import { setStorageNamespace } from './storageNamespace'

const baseSession: SavedSession = {
  sessionId: 'pty-1',
  claudeSessionId: 'claude-chat',
  codexSessionId: 'codex-chat',
  antigravitySessionId: 'antigravity-chat',
  cwd: 'D:\\Work\\Project',
  agent: 'claude',
  timestamp: 1000,
}

describe('savedConversationIdFor', () => {
  it('returns the saved Claude id when agent and cwd match', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Project/')).toBe('claude-chat')
  })

  it('ignores saved sessions from another agent', () => {
    expect(savedConversationIdFor(baseSession, 'codex', 'D:/Work/Project')).toBeUndefined()
  })

  it('ignores saved sessions from another cwd', () => {
    expect(savedConversationIdFor(baseSession, 'claude', 'D:/Work/Other')).toBeUndefined()
  })

  it('returns the saved Antigravity conversation id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'antigravity' },
        'antigravity',
        'D:/Work/Project',
      ),
    ).toBe('antigravity-chat')
  })

  it('returns the saved OpenCode session id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'opencode', opencodeSessionId: 'opencode-chat' },
        'opencode',
        'D:/Work/Project',
      ),
    ).toBe('opencode-chat')
  })

  it('returns undefined when there is no saved session, agent, or cwd', () => {
    expect(savedConversationIdFor(null, 'claude', 'D:/Work/Project')).toBeUndefined()
    expect(savedConversationIdFor(baseSession, null, 'D:/Work/Project')).toBeUndefined()
    expect(savedConversationIdFor(baseSession, 'claude', null)).toBeUndefined()
  })
})

describe('saveSession / getActiveSessions / removeSession / consumeSession', () => {
  beforeEach(() => {
    localStorage.clear()
    setStorageNamespace('default')
  })

  it('round-trips a session under its pty id', () => {
    saveSession('pty-1', baseSession)
    expect(getActiveSessions()).toEqual({ 'pty-1': baseSession })
    removeSession('pty-1')
    expect(getActiveSessions()).toEqual({})
  })

  it('keeps sessions from other panes untouched when saving/removing one', () => {
    saveSession('pty-1', baseSession)
    saveSession('pty-2', { ...baseSession, agent: 'codex' })
    removeSession('pty-1')
    expect(Object.keys(getActiveSessions())).toEqual(['pty-2'])
  })

  it('consumeSession returns and deletes the session, then returns null on a second call', () => {
    saveSession('pty-1', baseSession)
    expect(consumeSession('pty-1')).toEqual(baseSession)
    expect(consumeSession('pty-1')).toBeNull()
    expect(getActiveSessions()).toEqual({})
  })

  it('does not leak sessions saved under a different storage profile', () => {
    setStorageNamespace('work')
    saveSession('pty-1', baseSession)
    setStorageNamespace('personal')
    expect(getActiveSessions()).toEqual({})
    expect(consumeSession('pty-1')).toBeNull()
  })

  it('getActiveSessions recovers gracefully from corrupted storage', () => {
    setStorageNamespace('default')
    localStorage.setItem('alethe:default:active-sessions', '{not json')
    expect(getActiveSessions()).toEqual({})
  })
})
