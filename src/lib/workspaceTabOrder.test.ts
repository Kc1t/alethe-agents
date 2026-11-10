import { describe, expect, it } from 'vitest'

import {
  dropIndexFor,
  moveWorkspaceTab,
  placeOpenedTab,
  shiftForNeighbour,
} from './workspaceTabOrder'

type Tab = { id: string; pinned?: boolean }
const ids = (tabs: Tab[]) => tabs.map((tab) => tab.id)
const tabs: Tab[] = [
  { id: 'p1', pinned: true },
  { id: 'p2', pinned: true },
  { id: 'a' },
  { id: 'b' },
  { id: 'c' },
]

describe('moveWorkspaceTab', () => {
  it('moves a tab to the given position', () => {
    expect(ids(moveWorkspaceTab(tabs, 'c', 2))).toEqual(['p1', 'p2', 'c', 'a', 'b'])
    expect(ids(moveWorkspaceTab(tabs, 'a', 4))).toEqual(['p1', 'p2', 'b', 'c', 'a'])
  })

  it('keeps an unpinned tab after the pinned ones', () => {
    expect(ids(moveWorkspaceTab(tabs, 'b', 0))).toEqual(['p1', 'p2', 'b', 'a', 'c'])
  })

  it('keeps a pinned tab inside the pinned group', () => {
    expect(ids(moveWorkspaceTab(tabs, 'p1', 4))).toEqual(['p2', 'p1', 'a', 'b', 'c'])
  })

  it('returns the same array when nothing moves', () => {
    expect(moveWorkspaceTab(tabs, 'a', 2)).toBe(tabs)
    expect(moveWorkspaceTab(tabs, 'missing', 0)).toBe(tabs)
  })
})

describe('placeOpenedTab', () => {
  it('keeps the position of a tab that is already open', () => {
    const next = placeOpenedTab(tabs, { id: 'a', pinned: false })
    expect(ids(next)).toEqual(ids(tabs))
    expect(next[2]).toEqual({ id: 'a', pinned: false })
  })

  it('appends a tab that is not open yet', () => {
    expect(ids(placeOpenedTab(tabs, { id: 'd' }))).toEqual([...ids(tabs), 'd'])
  })
})

describe('dropIndexFor', () => {
  const slots = [
    { left: 0, width: 100 },
    { left: 104, width: 100 },
    { left: 208, width: 100 },
  ]

  it('stays in place for a small drag', () => {
    expect(dropIndexFor(slots, 0, 20)).toBe(0)
  })

  it('passes a neighbour once the dragged centre crosses its centre', () => {
    expect(dropIndexFor(slots, 0, 110)).toBe(1)
    expect(dropIndexFor(slots, 0, 300)).toBe(2)
    expect(dropIndexFor(slots, 2, -110)).toBe(1)
    expect(dropIndexFor(slots, 2, -500)).toBe(0)
  })
})

describe('shiftForNeighbour', () => {
  it('slides the tabs between the old and new slot to fill the gap', () => {
    expect(shiftForNeighbour(1, 0, 2, 104)).toBe(-104)
    expect(shiftForNeighbour(2, 0, 2, 104)).toBe(-104)
    expect(shiftForNeighbour(0, 2, 0, 104)).toBe(104)
    expect(shiftForNeighbour(1, 2, 0, 104)).toBe(104)
  })

  it('leaves the other tabs where they are', () => {
    expect(shiftForNeighbour(3, 0, 2, 104)).toBe(0)
    expect(shiftForNeighbour(0, 1, 1, 104)).toBe(0)
  })
})
