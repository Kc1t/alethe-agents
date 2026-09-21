import { describe, expect, it } from 'vitest'

import { savedConversationIdFor, type SavedSession } from './sessionResume'

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

  it('returns the saved Cursor chat id', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'cursor', cursorSessionId: 'cursor-chat' },
        'cursor',
        'D:/Work/Project',
      ),
    ).toBe('cursor-chat')
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
})
