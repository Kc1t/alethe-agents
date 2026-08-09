import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDiscoveredSession,
  claimMostRecentSession,
  registerSessionClaim,
  releaseSessionClaim,
  resetSessionClaimsForTests,
} from './sessionDiscovery'

describe('claimDiscoveredSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('claims the only new session after the before snapshot', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'D:\\repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new', modified_at_ms: 2 },
      ],
      'pty-1',
    )

    expect(claimed?.id).toBe('new')
  })

  it('a second concurrent claim for the same session gets nothing', () => {
    const before = new Set(['old'])
    const sessions = [
      { id: 'new', modified_at_ms: 200 },
      { id: 'old', modified_at_ms: 50 },
    ]

    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)?.id).toBe('new')
    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)).toBeUndefined()
  })

  it('known pane ids registered via registerSessionClaim are excluded from later discovery', () => {
    registerSessionClaim('codex', 'C:\\repo', 'assigned')
    const result = claimDiscoveredSession('codex', 'c:\\REPO', new Set(), [
      { id: 'assigned', modified_at_ms: 1 },
      { id: 'free', modified_at_ms: 2 },
    ])
    expect(result?.id).toBe('free')
  })

  it('does not claim when multiple new sessions make the pane mapping ambiguous', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'D:\\repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new-a', modified_at_ms: 2 },
        { id: 'new-b', modified_at_ms: 3 },
      ],
      'pty-1',
    )

    expect(claimed).toBeUndefined()
  })
})

describe('claimMostRecentSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('claims the most recently modified session for a cwd', () => {
    const claimed = claimMostRecentSession(
      'codex',
      'D:\\repo',
      [
        { id: 'older', modified_at_ms: 100 },
        { id: 'newest', modified_at_ms: 300 },
        { id: 'middle', modified_at_ms: 200 },
      ],
      'pty-1',
    )

    expect(claimed?.id).toBe('newest')
  })

  it('skips sessions already claimed by another pane', () => {
    claimMostRecentSession('codex', 'D:\\repo', [{ id: 'newest', modified_at_ms: 300 }], 'pty-1')

    const claimed = claimMostRecentSession(
      'codex',
      'D:\\repo',
      [
        { id: 'newest', modified_at_ms: 300 },
        { id: 'older', modified_at_ms: 100 },
      ],
      'pty-2',
    )

    expect(claimed?.id).toBe('older')
  })

  it('returns undefined when there is nothing left to claim', () => {
    expect(claimMostRecentSession('codex', 'D:\\repo', [])).toBeUndefined()
  })
})

// Sem isso, claimedIds cresceria sem limite pela vida inteira do app: uma
// entrada por sessão já reivindicada, mesmo depois do pane que a reivindicou
// ter fechado — e a sessão nunca mais poderia ser reivindicada por outro pane.
describe('releaseSessionClaim', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('frees a session claimed via claimDiscoveredSession so another pane can claim it', () => {
    const before = new Set(['old'])
    const sessions = [
      { id: 'new', modified_at_ms: 200 },
      { id: 'old', modified_at_ms: 50 },
    ]
    claimDiscoveredSession('codex', 'C:\\repo', before, sessions, 'pty-1')
    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)).toBeUndefined()

    releaseSessionClaim('pty-1')

    expect(claimDiscoveredSession('codex', 'C:\\repo', before, sessions)?.id).toBe('new')
  })

  it('frees a session claimed via registerSessionClaim', () => {
    registerSessionClaim('codex', 'C:\\repo', 'assigned', 'pty-1')
    expect(
      claimDiscoveredSession('codex', 'C:\\repo', new Set(), [
        { id: 'assigned', modified_at_ms: 1 },
      ]),
    ).toBeUndefined()

    releaseSessionClaim('pty-1')

    expect(
      claimDiscoveredSession('codex', 'C:\\repo', new Set(), [
        { id: 'assigned', modified_at_ms: 1 },
      ])?.id,
    ).toBe('assigned')
  })

  it('only releases claims owned by the given pty id, leaving other panes untouched', () => {
    registerSessionClaim('codex', 'C:\\repo', 'pane-a-session', 'pty-a')
    registerSessionClaim('codex', 'C:\\repo', 'pane-b-session', 'pty-b')

    releaseSessionClaim('pty-a')

    expect(
      claimDiscoveredSession('codex', 'C:\\repo', new Set(), [
        { id: 'pane-a-session', modified_at_ms: 1 },
      ])?.id,
    ).toBe('pane-a-session')
    expect(
      claimDiscoveredSession('codex', 'C:\\repo', new Set(), [
        { id: 'pane-b-session', modified_at_ms: 1 },
      ]),
    ).toBeUndefined()
  })

  it('is a no-op for a pty id that never registered any claim', () => {
    expect(() => releaseSessionClaim('never-seen')).not.toThrow()
  })
})
