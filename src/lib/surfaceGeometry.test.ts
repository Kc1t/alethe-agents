import { afterEach, describe, expect, it, vi } from 'vitest'

import { surfaceRectsEqual, toPhysicalRect, visibleRectOf } from './surfaceGeometry'

type Box = { x: number; y: number; width: number; height: number }

const boxes = new Map<Element, Box>()

function place(element: Element, box: Box, style: Partial<CSSStyleDeclaration> = {}): void {
  boxes.set(element, box)
  Object.assign((element as HTMLElement).style, {
    overflowX: 'visible',
    overflowY: 'visible',
    position: 'static',
    ...style,
  })
}

vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
  const box = boxes.get(this) ?? { x: 0, y: 0, width: 0, height: 0 }
  return {
    ...box,
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => box,
  } as DOMRect
})

function tree(depth: number): HTMLElement[] {
  const nodes: HTMLElement[] = []
  let parent: HTMLElement = document.body
  for (let index = 0; index < depth; index += 1) {
    const node = document.createElement('div')
    parent.appendChild(node)
    nodes.push(node)
    parent = node
  }
  return nodes
}

afterEach(() => {
  boxes.clear()
  document.body.innerHTML = ''
  window.innerWidth = 1024
  window.innerHeight = 768
})

describe('visibleRectOf', () => {
  it('returns the whole box when nothing clips it', () => {
    const [node] = tree(1)
    place(node!, { x: 10, y: 20, width: 100, height: 50 })
    expect(visibleRectOf(node!)).toEqual({ x: 10, y: 20, width: 100, height: 50 })
  })

  it('clips to an ancestor that hides its overflow', () => {
    const [outer, node] = tree(2)
    place(outer!, { x: 0, y: 0, width: 100, height: 100 }, { overflowY: 'hidden' })
    place(node!, { x: 0, y: 50, width: 100, height: 200 })
    expect(visibleRectOf(node!), 'the half below the container must be dropped').toEqual({
      x: 0,
      y: 50,
      width: 100,
      height: 50,
    })
  })

  it('applies every clipping ancestor, not just the nearest', () => {
    const [outer, middle, node] = tree(3)
    place(outer!, { x: 0, y: 0, width: 200, height: 200 }, { overflowX: 'hidden' })
    place(middle!, { x: 50, y: 0, width: 300, height: 200 }, { overflowX: 'hidden' })
    place(node!, { x: 0, y: 0, width: 400, height: 100 })
    expect(visibleRectOf(node!)).toEqual({ x: 50, y: 0, width: 150, height: 100 })
  })

  it('returns null when an ancestor clips it away entirely', () => {
    const [outer, node] = tree(2)
    place(outer!, { x: 0, y: 0, width: 100, height: 100 }, { overflowY: 'hidden' })
    place(node!, { x: 0, y: 300, width: 100, height: 100 })
    expect(visibleRectOf(node!)).toBeNull()
  })

  it('stops clipping above a fixed ancestor, so focus mode is not cut', () => {
    const [outer, fixed, node] = tree(3)
    place(outer!, { x: 0, y: 0, width: 100, height: 100 }, { overflowY: 'hidden' })
    place(fixed!, { x: 0, y: 0, width: 800, height: 600 }, { position: 'fixed' })
    place(node!, { x: 24, y: 24, width: 700, height: 500 })
    expect(visibleRectOf(node!)).toEqual({ x: 24, y: 24, width: 700, height: 500 })
  })

  it('clips to the viewport', () => {
    const [node] = tree(1)
    window.innerWidth = 300
    window.innerHeight = 300
    place(node!, { x: 200, y: 200, width: 400, height: 400 })
    expect(visibleRectOf(node!)).toEqual({ x: 200, y: 200, width: 100, height: 100 })
  })

  it('returns null for a degenerate box', () => {
    const [node] = tree(1)
    place(node!, { x: 0, y: 0, width: 0, height: 0 })
    expect(visibleRectOf(node!)).toBeNull()
  })
})

describe('toPhysicalRect', () => {
  it('is the identity at ratio 1', () => {
    expect(toPhysicalRect({ x: 3, y: 4, width: 5, height: 6 }, 1)).toEqual({
      x: 3,
      y: 4,
      width: 5,
      height: 6,
    })
  })

  it('scales and rounds at fractional and integer ratios', () => {
    expect(toPhysicalRect({ x: 10, y: 20, width: 30, height: 40 }, 2)).toEqual({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    })
    expect(toPhysicalRect({ x: 10.5, y: 20.5, width: 31, height: 41 }, 1.5)).toEqual({
      x: 16,
      y: 31,
      width: 47,
      height: 62,
    })
  })

  it('never collapses a surface to zero and treats a bogus ratio as 1', () => {
    expect(toPhysicalRect({ x: 0, y: 0, width: 1, height: 1 }, 0.1)).toMatchObject({
      width: 1,
      height: 1,
    })
    expect(toPhysicalRect({ x: 2, y: 2, width: 4, height: 4 }, 0)).toEqual({
      x: 2,
      y: 2,
      width: 4,
      height: 4,
    })
  })

  it('changes when only the ratio changes, so a DPI move forces a resync', () => {
    const css = { x: 10, y: 10, width: 100, height: 100 }
    expect(surfaceRectsEqual(toPhysicalRect(css, 1), toPhysicalRect(css, 2))).toBe(false)
  })
})

describe('surfaceRectsEqual', () => {
  it('matches identical rects and rejects any differing field', () => {
    expect(
      surfaceRectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
    ).toBe(true)
    expect(
      surfaceRectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 9, y: 2, width: 3, height: 4 }),
    ).toBe(false)
    expect(
      surfaceRectsEqual({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 9 }),
    ).toBe(false)
  })

  it('treats null as equal only to null', () => {
    expect(surfaceRectsEqual(null, null)).toBe(true)
    expect(surfaceRectsEqual(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
  })
})
