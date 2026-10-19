import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { VoiceDockPosition } from '../../lib/types'
import { dockFraction, dockOffset } from '../../lib/voice/dockPlacement'

type Size = { width: number; height: number }
type Offset = { left: number; top: number }
type Drag = { startX: number; startY: number; from: Offset; size: Size; at: Offset | null }

const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight })

/**
 * The in-window voice panel's place: where it was dragged (`saved`), kept inside the window as
 * the window or the panel changes size, or the stylesheet's bottom center. A drag from the strip
 * moves it with the pointer and saves where it ends.
 */
export function useDockPosition(
  saved: VoiceDockPosition | null,
  save: (position: VoiceDockPosition) => void,
) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [viewport, setViewport] = useState(windowSize)
  const [dragAt, setDragAt] = useState<Offset | null>(null)
  const drag = useRef<Drag | null>(null)

  // Before paint, so a saved spot never flashes at the default one first.
  useLayoutEffect(() => {
    if (!node) {
      setSize(null)
      return
    }
    const measure = () =>
      setSize((current) =>
        current?.width === node.offsetWidth && current.height === node.offsetHeight
          ? current
          : { width: node.offsetWidth, height: node.offsetHeight },
      )
    measure()
    // A permission card or a longer narration makes the panel taller.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [node])

  useEffect(() => {
    const onResize = () => setViewport(windowSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const offset = dragAt ?? (saved && size ? dockOffset(saved, viewport, size) : null)
  const style: CSSProperties | undefined = offset
    ? { left: offset.left, top: offset.top, bottom: 'auto', transform: 'none' }
    : undefined

  function end() {
    const current = drag.current
    drag.current = null
    setDragAt(null)
    if (current?.at) save(dockFraction(current.at, windowSize(), current.size))
  }

  const handle = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button > 0 || !node) return
      // No text selection, and no focus taken from the terminal.
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const rect = node.getBoundingClientRect()
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        from: { left: rect.left, top: rect.top },
        size: { width: rect.width, height: rect.height },
        at: null,
      }
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const current = drag.current
      if (!current) return
      const wanted = {
        left: current.from.left + event.clientX - current.startX,
        top: current.from.top + event.clientY - current.startY,
      }
      const bounds = windowSize()
      // Through the saved form and back, which keeps it inside the window's margins.
      current.at = dockOffset(dockFraction(wanted, bounds, current.size), bounds, current.size)
      setDragAt(current.at)
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  }

  return { ref: setNode, style, handle }
}
