import { describe, expect, it } from 'vitest'

import { projectDropGroupId, sidebarInsertionIndex } from './sidebarDrag'

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

describe('projectDropGroupId', () => {
  it('reads the group from its header or its body, and ungrouped as null', () => {
    expect(projectDropGroupId('group:g1')).toBe('g1')
    expect(projectDropGroupId('group-body:g1')).toBe('g1')
    expect(projectDropGroupId('group:ungrouped')).toBeNull()
  })

  it('is undefined for anything that is not a group drop target', () => {
    expect(projectDropGroupId('proj:p1')).toBeUndefined()
    expect(projectDropGroupId('grp:g1')).toBeUndefined()
  })
})
