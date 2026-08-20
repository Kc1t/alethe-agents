import { describe, expect, it } from 'vitest'

import {
  decideHermesChildSessionObservation,
  hermesSessionsNearTransition,
} from './hermesSessionAuthority'
import { claimDiscoveredSession, resetSessionClaimsForTests } from './sessionDiscovery'

describe('Hermes session authority', () => {
  it('adopts durable child observations without database fallback', () => {
    expect(
      decideHermesChildSessionObservation('657e406b', {
        kind: 'durable',
        session_id: '20260820_010203_durable1',
        changed_at_ms: 1_000,
      }),
    ).toEqual({
      durableSessionId: '20260820_010203_durable1',
      nextLiveHandle: null,
      requestDatabase: false,
    })
  })

  it('requests one database lookup only when the live handle changes', () => {
    expect(
      decideHermesChildSessionObservation(null, {
        kind: 'live',
        session_id: '657e406b',
        changed_at_ms: 1_000,
      }),
    ).toEqual({ nextLiveHandle: '657e406b', requestDatabase: true })
    expect(
      decideHermesChildSessionObservation('657e406b', {
        kind: 'live',
        session_id: '657e406b',
        changed_at_ms: 1_000,
      }),
    ).toEqual({ nextLiveHandle: '657e406b', requestDatabase: false })
    expect(
      decideHermesChildSessionObservation('657e406b', {
        kind: 'live',
        session_id: '18a524ff',
        changed_at_ms: 2_000,
      }),
    ).toEqual({ nextLiveHandle: '18a524ff', requestDatabase: true })
  })

  it('ignores malformed observations defensively', () => {
    expect(
      decideHermesChildSessionObservation('657e406b', {
        kind: 'durable',
        session_id: 'not-resumable',
        changed_at_ms: 1_000,
      }),
    ).toEqual({ nextLiveHandle: '657e406b', requestDatabase: false })
    expect(
      decideHermesChildSessionObservation('657e406b', {
        kind: 'live',
        session_id: 'too-long-live',
        changed_at_ms: 1_000,
      }),
    ).toEqual({ nextLiveHandle: '657e406b', requestDatabase: false })
  })

  it('recovers an existing row near the trusted transition without guessing under concurrency', () => {
    resetSessionClaimsForTests()
    const decision = decideHermesChildSessionObservation(null, {
      kind: 'live',
      session_id: '657e406b',
      changed_at_ms: 100_000,
    })
    expect(decision.requestDatabase).toBe(true)

    const sessions = [
      { id: '20260820_010200_old001', started_at_ms: 1_000, modified_at_ms: 1 },
      { id: '20260820_010201_pane01', started_at_ms: 100_500, modified_at_ms: 2 },
      { id: '20260820_010202_other1', started_at_ms: 200_000, modified_at_ms: 3 },
    ]
    const correlated = hermesSessionsNearTransition(sessions, 100_000, 1_000)
    expect(correlated.map((session) => session.id)).toEqual(['20260820_010201_pane01'])
    expect(
      claimDiscoveredSession(
        'hermes',
        '/work/project',
        new Set(['20260820_010200_old001']),
        correlated,
        'pane-a',
      )?.id,
    ).toBe('20260820_010201_pane01')

    resetSessionClaimsForTests()
    const concurrent = hermesSessionsNearTransition(
      [...sessions, { id: '20260820_010203_race01', started_at_ms: 100_700, modified_at_ms: 4 }],
      100_000,
      1_000,
    )
    expect(
      claimDiscoveredSession(
        'hermes',
        '/work/project',
        new Set(['20260820_010200_old001']),
        concurrent,
        'pane-a',
      ),
    ).toBeUndefined()
  })
})
