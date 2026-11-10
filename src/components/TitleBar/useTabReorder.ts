import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useRef,
  useState,
} from 'react'

import { dropIndexFor, shiftForNeighbour } from '../../lib/workspaceTabOrder'

const DRAG_THRESHOLD_PX = 4
const SETTLE_MS = 140

type ReorderTab = { id: string; pinned?: boolean }
type Slot = { left: number; width: number }
type Drag = {
  id: string
  from: number
  to: number
  deltaX: number
  step: number
  slots: Slot[]
  settling: boolean
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

/** Chrome-style drag and keyboard reordering for a horizontal tab strip. */
export function useTabReorder(
  tabs: readonly ReorderTab[],
  onMove: (tabId: string, toIndex: number) => void,
) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const pending = useRef<{ id: string; startX: number } | null>(null)
  const suppressClick = useRef(false)

  const groupBounds = useCallback(
    (index: number): [number, number] => {
      const pinnedCount = tabs.filter((tab) => tab.pinned).length
      return tabs[index]?.pinned ? [0, pinnedCount - 1] : [pinnedCount, tabs.length - 1]
    },
    [tabs],
  )

  const register = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) nodes.current.set(id, node)
      else nodes.current.delete(id)
    },
    [],
  )

  const startDrag = (id: string, event: PointerEvent<HTMLElement>): Drag | null => {
    const from = tabs.findIndex((tab) => tab.id === id)
    const slots = tabs.map((tab) => {
      const rect = nodes.current.get(tab.id)?.getBoundingClientRect()
      return { left: rect?.left ?? 0, width: rect?.width ?? 0 }
    })
    if (from === -1) return null
    const next = slots[from + 1] ?? slots[from - 1]
    const gap = next ? Math.abs(next.left - slots[from].left) - slots[from].width : 0
    event.currentTarget.setPointerCapture(event.pointerId)
    return { id, from, to: from, deltaX: 0, step: slots[from].width + gap, slots, settling: false }
  }

  const finish = (current: Drag) => {
    suppressClick.current = true
    const commit = () => {
      setDrag(null)
      if (current.to !== current.from) onMove(current.id, current.to)
    }
    if (prefersReducedMotion()) {
      commit()
      return
    }
    const target = current.slots[current.to]
    const origin = current.slots[current.from]
    const landingLeft =
      current.to > current.from ? target.left + target.width - origin.width : target.left
    const slotOffset = landingLeft - origin.left
    setDrag({ ...current, deltaX: slotOffset, settling: true })
    window.setTimeout(commit, SETTLE_MS)
  }

  const handlers = (id: string) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0 || drag) return
      if ((event.target as HTMLElement).closest('[data-tab-no-drag]')) return
      pending.current = { id, startX: event.clientX }
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const start = pending.current
      if (!start || start.id !== id || drag?.settling) return
      const deltaX = event.clientX - start.startX
      const current = drag ?? (Math.abs(deltaX) > DRAG_THRESHOLD_PX ? startDrag(id, event) : null)
      if (!current) return
      const [min, max] = groupBounds(current.from)
      const to = Math.min(Math.max(dropIndexFor(current.slots, current.from, deltaX), min), max)
      setDrag({ ...current, deltaX, to })
    },
    onPointerUp: () => {
      pending.current = null
      if (drag && !drag.settling) finish(drag)
    },
    onPointerCancel: () => {
      pending.current = null
      if (drag && !drag.settling) setDrag(null)
    },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.ctrlKey || !event.shiftKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const index = tabs.findIndex((tab) => tab.id === id)
      event.preventDefault()
      onMove(id, index + (event.key === 'ArrowLeft' ? -1 : 1))
    },
  })

  const styleFor = (id: string, index: number): CSSProperties | undefined => {
    if (!drag) return undefined
    if (id === drag.id) {
      return {
        transform: `translateX(${drag.deltaX}px)`,
        transition: drag.settling ? undefined : 'none',
        zIndex: 2,
      }
    }
    const shift = shiftForNeighbour(index, drag.from, drag.to, drag.step)
    return shift ? { transform: `translateX(${shift}px)` } : undefined
  }

  return { draggingId: drag?.id ?? null, register, handlers, styleFor }
}
