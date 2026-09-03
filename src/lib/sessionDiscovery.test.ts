import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDiscoveredSession,
  pickSwitchedSession,
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

describe('pickSwitchedSession', () => {
  beforeEach(() => {
    resetSessionClaimsForTests()
  })

  it('adopts the single unclaimed session written after the pane stopped writing its own', () => {
    const switched = pickSwitchedSession(
      'claude',
      'D:/repo',
      { id: 'mine', modified_at_ms: 10 },
      [
        { id: 'mine', modified_at_ms: 10 },
        { id: 'resumed', modified_at_ms: 20 },
      ],
      'tab-1',
    )

    expect(switched?.id).toBe('resumed')
  })

  it('never adopts the session another pane in the same folder is writing', () => {
    registerSessionClaim('claude', 'D:/repo', 'neighbour', 'tab-2')

    const switched = pickSwitchedSession(
      'claude',
      'd:/REPO',
      { id: 'mine', modified_at_ms: 10 },
      [
        { id: 'mine', modified_at_ms: 10 },
        { id: 'neighbour', modified_at_ms: 99 },
      ],
      'tab-1',
    )

    expect(switched).toBeUndefined()
  })

  it('still adopts a session this same pane already claims', () => {
    registerSessionClaim('claude', 'D:/repo', 'resumed', 'tab-1')

    const switched = pickSwitchedSession(
      'claude',
      'D:/repo',
      { id: 'mine', modified_at_ms: 10 },
      [
        { id: 'mine', modified_at_ms: 10 },
        { id: 'resumed', modified_at_ms: 20 },
      ],
      'tab-1',
    )

    expect(switched?.id).toBe('resumed')
  })

  it('stays put when more than one unclaimed session is newer', () => {
    const switched = pickSwitchedSession(
      'claude',
      'D:/repo',
      { id: 'mine', modified_at_ms: 10 },
      [
        { id: 'mine', modified_at_ms: 10 },
        { id: 'a', modified_at_ms: 20 },
        { id: 'b', modified_at_ms: 30 },
      ],
      'tab-1',
    )

    expect(switched).toBeUndefined()
  })
})
