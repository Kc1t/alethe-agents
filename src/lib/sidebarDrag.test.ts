import { describe, expect, it } from 'vitest'

import { sidebarInsertionIndex } from './sidebarDrag'

describe('sidebarInsertionIndex', () => {
  it('places a same-list item before or after the hovered row', () => {
    expect(sidebarInsertionIndex(0, 2, 'before', true)).toBe(1)
    expect(sidebarInsertionIndex(0, 2, 'after', true)).toBe(2)
    expect(sidebarInsertionIndex(2, 1, 'before', true)).toBe(1)
    expect(sidebarInsertionIndex(2, 1, 'after', true)).toBe(2)
  })

  it('keeps the target index stable when moving across lists', () => {
    expect(sidebarInsertionIndex(3, 1, 'before', false)).toBe(1)
    expect(sidebarInsertionIndex(3, 1, 'after', false)).toBe(2)
  })
})
