import { beforeEach, describe, expect, it } from 'vitest'

import {
  claimDiscoveredSession,
  isSessionClaimed,
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

describe('session claim ownership', () => {
  beforeEach(resetSessionClaimsForTests)

  it('retains a claim until both the tab and its PTY have released it', () => {
    registerSessionClaim('claude', 'D:/repo', 'chat', 'tab')
    registerSessionClaim('claude', 'D:/repo', 'chat', 'pty')
    releaseSessionClaim('pty')
    expect(isSessionClaimed('claude', 'D:/repo', 'chat', 'other-tab')).toBe(true)
    expect(isSessionClaimed('claude', 'D:/repo', 'chat', 'tab')).toBe(false)
    releaseSessionClaim('tab')
    expect(isSessionClaimed('claude', 'D:/repo', 'chat')).toBe(false)
  })

  it('treats equivalent Windows paths as the same conversation directory', () => {
    registerSessionClaim('claude', 'D:/Work/Repo/', 'chat', 'tab')
    expect(isSessionClaimed('claude', 'd:\\work\\repo', 'chat', 'other')).toBe(true)
    expect(
      claimDiscoveredSession(
        'claude',
        'D:\\Work\\Repo\\',
        new Set(),
        [{ id: 'chat', modified_at_ms: 1 }],
        'other',
      ),
    ).toBeUndefined()
  })
})
