import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

import { ZOOM_MAX, ZOOM_MIN } from '../../../lib/agentCanvasConfig'

export function useCanvasZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  stageRef: RefObject<HTMLDivElement | null>,
) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [panning, setPanning] = useState(false)

  const panStartRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null)

  const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
  const zoomBy = useCallback((delta: number) => setZoom((z) => clampZoom(z + delta)), [])

  const fitZoom = useCallback(() => {
    const container = containerRef.current
    const stage = stageRef.current
    if (!container || !stage) return
    const naturalH = stage.scrollHeight
    const naturalW = stage.scrollWidth
    if (!naturalH || !naturalW) return
    const availH = container.clientHeight - 16
    const availW = container.clientWidth - 16
    setPan({ x: 0, y: 0 })
    setZoom(clampZoom(Math.min(1, availH / naturalH, availW / naturalW)))
  }, [containerRef, stageRef])

  // Zoom com a roda do mouse (canvas de verdade). Listener nativo non-passive

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerRef])

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement

    if (
      e.button === 0 &&
      target.closest(
        'button, input, textarea, select, a, [role="button"], [class*="terminal"], [data-no-pan]',
      )
    ) {
      return
    }
    panStartRef.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y }
    setPanning(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
  }
  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current
    if (!start) return
    setPan({ x: start.px + (e.clientX - start.mx), y: start.py + (e.clientY - start.my) })
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return
    panStartRef.current = null
    setPanning(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ok */
    }
  }

  return { zoom, pan, panning, zoomBy, fitZoom, onCanvasPointerDown, onCanvasPointerMove, endPan }
}
