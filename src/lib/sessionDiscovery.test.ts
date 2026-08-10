import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDiscoveredSession,
  claimMostRecentSession,
  registerSessionClaim,
  resetSessionClaimsForTests,
} from './sessionDiscovery'

describe('claimDiscoveredSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('claims the only new session after the before snapshot', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'X:\\example-repo',
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

    expect(claimDiscoveredSession('codex', 'X:\\example-repo', before, sessions)?.id).toBe('new')
    expect(claimDiscoveredSession('codex', 'X:\\example-repo', before, sessions)).toBeUndefined()
  })

  it('known pane ids registered via registerSessionClaim are excluded from later discovery', () => {
    registerSessionClaim('codex', 'X:\\example-repo', 'assigned')
    const result = claimDiscoveredSession('codex', 'x:\\EXAMPLE-REPO', new Set(), [
      { id: 'assigned', modified_at_ms: 1 },
      { id: 'free', modified_at_ms: 2 },
    ])
    expect(result?.id).toBe('free')
  })

  it('does not claim when multiple new sessions make the pane mapping ambiguous', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'X:\\example-repo',
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

  it('a single new session already reserved by another tab is not claimed', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'X:\\example-repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new', modified_at_ms: 2 },
      ],
      'pty-1',
      new Set(['new']),
    )

    expect(claimed).toBeUndefined()
  })

  it('omitting reservedIds preserves current behavior', () => {
    const claimed = claimDiscoveredSession(
      'codex',
      'X:\\example-repo',
      new Set(['old']),
      [
        { id: 'old', modified_at_ms: 1 },
        { id: 'new', modified_at_ms: 2 },
      ],
      'pty-1',
    )

    expect(claimed?.id).toBe('new')
  })
})

describe('claimMostRecentSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('claims the most recently modified unclaimed session', () => {
    const claimed = claimMostRecentSession('opencode', 'X:\\example-repo', [
      { id: 'older', modified_at_ms: 1 },
      { id: 'newest', modified_at_ms: 3 },
      { id: 'middle', modified_at_ms: 2 },
    ])

    expect(claimed?.id).toBe('newest')
  })

  it('skips a reserved candidate even when it is the most recent, falling back to the next one', () => {
    const claimed = claimMostRecentSession(
      'opencode',
      'X:\\example-repo',
      [
        { id: 'older', modified_at_ms: 1 },
        { id: 'newest', modified_at_ms: 3 },
      ],
      undefined,
      new Set(['newest']),
    )

    expect(claimed?.id).toBe('older')
  })

  it('returns undefined when the only candidate is reserved', () => {
    const claimed = claimMostRecentSession(
      'opencode',
      'X:\\example-repo',
      [{ id: 'only', modified_at_ms: 1 }],
      undefined,
      new Set(['only']),
    )

    expect(claimed).toBeUndefined()
  })
})
