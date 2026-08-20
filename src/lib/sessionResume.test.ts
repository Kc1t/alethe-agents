import { describe, expect, it } from 'vitest'

import { RESUMABLE_AGENTS, savedConversationIdFor, type SavedSession } from './sessionResume'

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
  it('keeps Hermes in the shared resumable-agent registry', () => {
    expect(RESUMABLE_AGENTS).toContain('hermes')
  })

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

  it('returns the saved Hermes session id for the matching workspace', () => {
    expect(
      savedConversationIdFor(
        { ...baseSession, agent: 'hermes', hermesSessionId: '20260820_010203_abc123' },
        'hermes',
        'D:/Work/Project',
      ),
    ).toBe('20260820_010203_abc123')
  })
})
