import { describe, expect, it } from 'vitest'

import { moveItem } from './reorder'

describe('moveItem', () => {
  it('moves an item down and up', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('clamps a target past either end', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, -4)).toEqual(['c', 'a', 'b'])
  })

  it('leaves the list alone when there is nothing to move', () => {
    const list = ['a', 'b']
    expect(moveItem(list, 1, 1)).toEqual(list)
    expect(moveItem(list, 5, 0)).toEqual(list)
    expect(moveItem(list, 1, 1)).not.toBe(list)
  })
})
