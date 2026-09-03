import { describe, expect, it, vi } from 'vitest'

import { ContributionList } from './registry'

type Item = { id: string; value?: number }

describe('ContributionList', () => {
  it('exposes added contributions and keeps a stable snapshot between mutations', () => {
    const list = new ContributionList<Item>()
    const first = list.getSnapshot()
    expect(first).toHaveLength(0)
    expect(list.getSnapshot()).toBe(first)

    list.add('owner-a', { id: 'one' })
    const second = list.getSnapshot()
    expect(second).not.toBe(first)
    expect(second.map((i) => i.id)).toEqual(['one'])
    expect(list.getSnapshot()).toBe(second)
  })

  it('refuses a duplicate id', () => {
    const list = new ContributionList<Item>()
    list.add('owner-a', { id: 'one' })
    expect(() => list.add('owner-b', { id: 'one' })).toThrow('contribution_id_taken:one')
  })

  it('removes only the owner’s own contribution on dispose', () => {
    const list = new ContributionList<Item>()
    const a = list.add('owner-a', { id: 'one' })
    list.add('owner-b', { id: 'two' })

    a.dispose()
    expect(list.getSnapshot().map((i) => i.id)).toEqual(['two'])

    // Disposing twice is harmless and does not evict a later same-id entry.
    list.add('owner-c', { id: 'one' })
    a.dispose()
    expect(list.getSnapshot().map((i) => i.id).sort()).toEqual(['one', 'two'])
  })

  it('notifies subscribers on every mutation and stops after unsubscribe', () => {
    const list = new ContributionList<Item>()
    const listener = vi.fn()
    const unsubscribe = list.subscribe(listener)

    const handle = list.add('owner-a', { id: 'one' })
    expect(listener).toHaveBeenCalledTimes(1)
    handle.dispose()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    list.add('owner-a', { id: 'three' })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('looks contributions up by id and by owner', () => {
    const list = new ContributionList<Item>()
    list.add('owner-a', { id: 'one', value: 1 })
    list.add('owner-a', { id: 'two', value: 2 })
    list.add('owner-b', { id: 'three', value: 3 })

    expect(list.get('two')?.value).toBe(2)
    expect(list.get('missing')).toBeUndefined()
    expect(list.has('three')).toBe(true)
    expect(list.ownedBy('owner-a').map((i) => i.id)).toEqual(['one', 'two'])
  })
})
