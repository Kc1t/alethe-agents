import { describe, expect, it } from 'vitest'

import {
  firstUnclaimedSession,
  MAX_SESSION_LINEAGE,
  orderByTabLineage,
  withSessionLineage,
} from './sessionLineage'
import type { SubTab } from './types'

const tab = (patch: Partial<SubTab> = {}): SubTab => ({
  id: 'tab',
  type: 'claude',
  name: 'claude',
  ptyId: null,
  ...patch,
})

describe('withSessionLineage', () => {
  it('keeps the tab untouched when the conversation does not change', () => {
    const current = tab({ sessionId: 'a' })
    expect(withSessionLineage(current, 'a')).toBe(current)
  })

  it('records the conversation the tab leaves, newest first', () => {
    const next = withSessionLineage(tab({ sessionId: 'b', previousSessionIds: ['a'] }), 'c')
    expect(next.sessionId).toBe('c')
    expect(next.previousSessionIds).toEqual(['b', 'a'])
  })

  it('records the conversation when the tab is reset to a fresh one', () => {
    const next = withSessionLineage(tab({ sessionId: 'a' }), undefined)
    expect(next.sessionId).toBeUndefined()
    expect(next.previousSessionIds).toEqual(['a'])
  })

  it('moves a revisited conversation out of the lineage instead of duplicating it', () => {
    const next = withSessionLineage(tab({ sessionId: 'b', previousSessionIds: ['a', 'c'] }), 'a')
    expect(next.sessionId).toBe('a')
    expect(next.previousSessionIds).toEqual(['b', 'c'])
  })

  it('caps the lineage', () => {
    const many = Array.from({ length: MAX_SESSION_LINEAGE }, (_, index) => `old-${index}`)
    const next = withSessionLineage(tab({ sessionId: 'current', previousSessionIds: many }), 'new')
    expect(next.previousSessionIds).toHaveLength(MAX_SESSION_LINEAGE)
    expect(next.previousSessionIds?.[0]).toBe('current')
  })

  it('does not create an empty lineage for a brand-new tab', () => {
    expect(withSessionLineage(tab(), 'a').previousSessionIds).toBeUndefined()
  })
})

describe('firstUnclaimedSession', () => {
  it('returns the newest conversation no other pane holds', () => {
    expect(firstUnclaimedSession(['a', 'b', 'c'], (id) => id === 'a')).toBe('b')
  })

  it('returns undefined when every candidate is held', () => {
    expect(firstUnclaimedSession(['a'], () => true)).toBeUndefined()
    expect(firstUnclaimedSession(undefined, () => false)).toBeUndefined()
  })
})

describe('orderByTabLineage', () => {
  const sessions = [{ id: 'x' }, { id: 'b' }, { id: 'y' }, { id: 'a' }, { id: 'c' }]

  it('lists the current chat, then earlier ones from this tab, then the rest in order', () => {
    const ordered = orderByTabLineage(sessions, 'c', ['a', 'b'])
    expect(ordered.map((entry) => [entry.session.id, entry.mark])).toEqual([
      ['c', 'current'],
      ['a', 'previous'],
      ['b', 'previous'],
      ['x', undefined],
      ['y', undefined],
    ])
  })

  it('marks earlier chats even when the tab has no current one', () => {
    const ordered = orderByTabLineage(sessions, undefined, ['y'])
    expect(ordered[0]).toEqual({ session: { id: 'y' }, mark: 'previous' })
  })

  it('keeps the original order for a tab without history', () => {
    expect(orderByTabLineage(sessions, undefined, undefined).map((e) => e.session.id)).toEqual([
      'x',
      'b',
      'y',
      'a',
      'c',
    ])
  })
})
