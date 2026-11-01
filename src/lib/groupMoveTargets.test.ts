import { describe, expect, it } from 'vitest'

import { groupMoveTargets } from './groupMoveTargets'
import type { Group } from './types'

const group = (id: string, name: string, parentGroupId: string | null = null): Group =>
  ({ id, name, parentGroupId, projectIds: [], collapsed: false }) as unknown as Group

describe('groupMoveTargets', () => {
  it('lists every group a project can move to, with the path of nested ones', () => {
    const groups = [
      group('work', 'Work'),
      group('client', 'Client', 'work'),
      group('home', 'Personal'),
    ]
    expect(groupMoveTargets(groups, null)).toEqual([
      { id: 'work', label: 'Work' },
      { id: 'client', label: 'Work / Client' },
      { id: 'home', label: 'Personal' },
    ])
  })

  it('leaves out the group the project is already in', () => {
    const groups = [group('work', 'Work'), group('home', 'Personal')]
    expect(groupMoveTargets(groups, 'home')).toEqual([{ id: 'work', label: 'Work' }])
  })

  it('stops at a parent cycle instead of looping', () => {
    const groups = [group('a', 'A', 'b'), group('b', 'B', 'a')]
    expect(groupMoveTargets(groups, null).map((target) => target.id)).toEqual(['a', 'b'])
  })
})
