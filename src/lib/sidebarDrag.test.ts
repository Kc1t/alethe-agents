import type { DragMoveEvent } from '@dnd-kit/core'
import { describe, expect, it } from 'vitest'

import { sidebarDragKind, sidebarDropIndicatorForEvent, sidebarInsertionIndex } from './sidebarDrag'

describe('sidebarDragKind', () => {
  it('recognizes each supported draggable id', () => {
    expect(sidebarDragKind('proj:p1')).toBe('project')
    expect(sidebarDragKind('grp:g1')).toBe('group')
    expect(sidebarDragKind('term:p1:t1')).toBe('terminal')
    expect(sidebarDragKind('unknown')).toBeNull()
  })
})

describe('sidebarDropIndicatorForEvent', () => {
  const event = (activeId: string, overId: string | null, pointerY: number) =>
    ({
      active: { id: activeId, rect: { current: { translated: null } } },
      activatorEvent: { clientY: pointerY },
      delta: { x: 0, y: 0 },
      over: overId
        ? {
            id: overId,
            rect: { top: 100, height: 40, width: 100, left: 0, right: 100, bottom: 140 },
          }
        : null,
    }) as unknown as DragMoveEvent

  it('uses inside for group containers and terminal moves', () => {
    expect(sidebarDropIndicatorForEvent(event('proj:p1', 'group:g1', 110))).toEqual({
      id: 'group:g1',
      edge: 'inside',
    })
    expect(sidebarDropIndicatorForEvent(event('term:p1:t1', 'proj:p2', 110))).toEqual({
      id: 'proj:p2',
      edge: 'inside',
    })
  })

  it('selects before or after from the pointer position', () => {
    expect(sidebarDropIndicatorForEvent(event('proj:p1', 'proj:p2', 110))?.edge).toBe('before')
    expect(sidebarDropIndicatorForEvent(event('proj:p1', 'proj:p2', 130))?.edge).toBe('after')
    expect(sidebarDropIndicatorForEvent(event('proj:p1', null, 130))).toBeNull()
  })
})

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
