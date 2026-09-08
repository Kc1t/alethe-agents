import { describe, expect, it } from 'vitest'

import { collectDescendants } from './sidebarTree'
import type { Group } from './types'

const group = (id: string, parentGroupId: string | null): Group => ({
  id,
  parentGroupId,
  name: id,
  color: 'var(--accent)',
  collapsed: false,
  projectIds: [],
  createdAt: 0,
})

describe('collectDescendants', () => {
  it('collects nested descendants without including unrelated groups', () => {
    const groups = [
      group('root', null),
      group('child', 'root'),
      group('grandchild', 'child'),
      group('unrelated', null),
    ]

    expect([...collectDescendants('root', groups)]).toEqual(['child', 'grandchild'])
  })

  it('terminates safely when persisted data contains a cycle', () => {
    const groups = [group('root', 'child'), group('child', 'root')]

    expect([...collectDescendants('root', groups)]).toEqual(['child'])
  })
})
