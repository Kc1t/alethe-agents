import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTabReorder } from './useTabReorder'

const TABS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const WIDTH = 100
const GAP = 4

function Strip({
  onMove,
  onOpen,
}: {
  onMove: (id: string, to: number) => void
  onOpen: () => void
}) {
  const reorder = useTabReorder(TABS, onMove)
  return (
    <div>
      {TABS.map((tab, index) => (
        <div
          key={tab.id}
          ref={reorder.register(tab.id)}
          data-testid={tab.id}
          data-left={index * (WIDTH + GAP)}
          style={reorder.styleFor(tab.id, index)}
          {...reorder.handlers(tab.id)}
        >
          <button type="button" onClick={onOpen}>
            {tab.id}
          </button>
        </div>
      ))}
    </div>
  )
}

// jsdom has no PointerEvent; fireEvent needs one to carry button and clientX.
class TestPointerEvent extends MouseEvent {
  pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const left = Number(this.dataset.left ?? 0)
    return { left, width: WIDTH, top: 0, height: 26, right: left + WIDTH, bottom: 26 } as DOMRect
  })
  HTMLElement.prototype.setPointerCapture = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useTabReorder', () => {
  it('moves a dragged tab to the slot it is dropped on and swallows the click', () => {
    const onMove = vi.fn()
    const onOpen = vi.fn()
    render(<Strip onMove={onMove} onOpen={onOpen} />)
    const tab = screen.getByTestId('a')
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(tab, { clientX: 130, pointerId: 1 })
    expect(screen.getByTestId('b').style.transform).toBe(`translateX(-${WIDTH + GAP}px)`)
    fireEvent.pointerUp(tab, { clientX: 130, pointerId: 1 })
    fireEvent.click(screen.getByText('a'))
    expect(onMove).toHaveBeenCalledWith('a', 1)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('lands the new order without animating the tabs back from their drag offsets', async () => {
    render(<Strip onMove={vi.fn()} onOpen={vi.fn()} />)
    const tab = screen.getByTestId('a')
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, pointerId: 1 })
    fireEvent.pointerMove(tab, { clientX: 130, pointerId: 1 })
    fireEvent.pointerUp(tab, { clientX: 130, pointerId: 1 })
    for (const id of ['a', 'b', 'c']) {
      expect(screen.getByTestId(id).style.transform).toBe('')
      expect(screen.getByTestId(id).style.transition).toBe('none')
    }
    await waitFor(() => expect(screen.getByTestId('b').style.transition).toBe(''))
  })

  it('treats a press without movement as a click', () => {
    const onMove = vi.fn()
    const onOpen = vi.fn()
    render(<Strip onMove={onMove} onOpen={onOpen} />)
    const tab = screen.getByTestId('b')
    fireEvent.pointerDown(tab, { button: 0, clientX: 110, pointerId: 1 })
    fireEvent.pointerMove(tab, { clientX: 112, pointerId: 1 })
    fireEvent.pointerUp(tab, { clientX: 112, pointerId: 1 })
    fireEvent.click(screen.getByText('b'))
    expect(onMove).not.toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('moves the focused tab with Ctrl+Shift+Arrow', () => {
    const onMove = vi.fn()
    render(<Strip onMove={onMove} onOpen={vi.fn()} />)
    fireEvent.keyDown(screen.getByText('b'), { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(screen.getByText('b'), { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(screen.getByText('b'), { key: 'ArrowRight' })
    expect(onMove.mock.calls).toEqual([
      ['b', 0],
      ['b', 2],
    ])
  })
})
