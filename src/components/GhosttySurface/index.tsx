import { useEffect, useRef } from 'react'

import { isOverlayPresent, subscribeOverlayPresence } from '../../lib/overlayPresence'
import { surfaceRectsEqual, visibleRectOf } from '../../lib/surfaceGeometry'
import {
  ghosttySetFocus,
  ghosttySetHidden,
  ghosttySpawn,
  ghosttySurfaceExited,
  ghosttySyncFrame,
  type WebRect,
} from '../../lib/tauri'

const EXIT_POLL_MS = 2500

export type GhosttySurfaceProps = {
  surfaceId: string

  cwd?: string

  command?: string

  active?: boolean
  onSpawned?: (id: string) => void

  onExit?: () => void
}

export function GhosttySurface({
  surfaceId,
  cwd,
  command,
  active = true,
  onSpawned,
  onExit,
}: GhosttySurfaceProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const lastRectRef = useRef<WebRect | null>(null)
  const rafRef = useRef<number | null>(null)
  const spawnedRef = useRef(false)

  const spawnArgsRef = useRef({ cwd, command })

  // a surface seria morta e recriada (e o terminal piscaria/reiniciaria).
  const onSpawnedRef = useRef(onSpawned)
  const onExitRef = useRef(onExit)
  useEffect(() => {
    onSpawnedRef.current = onSpawned
    onExitRef.current = onExit
  })

  const activeRef = useRef(active)

  const reevaluateVisibilityRef = useRef<(() => void) | null>(null)
  // scheduleFrame vive no efeito de ciclo de vida; exposto p/ o efeito de

  const scheduleFrameRef = useRef<(() => void) | null>(null)

  const pushFrameNowRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const node = placeholderRef.current
    if (!node) return

    let disposed = false

    const pushFrame = () => {
      rafRef.current = null
      if (disposed) return
      const r = visibleRectOf(node)
      if (!r) return

      const rect: WebRect = { x: r.x, y: r.y, width: r.width, height: r.height }
      if (surfaceRectsEqual(lastRectRef.current, rect)) return
      lastRectRef.current = rect
      void ghosttySyncFrame(surfaceId, rect, window.devicePixelRatio || 1)
    }

    const scheduleFrame = () => {
      if (rafRef.current !== null) return
      rafRef.current = window.requestAnimationFrame(pushFrame)
    }
    scheduleFrameRef.current = scheduleFrame

    const pushFrameNow = () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pushFrame()
    }
    pushFrameNowRef.current = pushFrameNow

    const start = async () => {
      try {
        const { cwd, command } = spawnArgsRef.current
        const res = await ghosttySpawn({ id: surfaceId, cwd, command })
        if (disposed) return
        spawnedRef.current = true
        onSpawnedRef.current?.(res.id)

        pushFrameNow()
        window.setTimeout(() => pushFrameNow(), 50)
      } catch (err) {
        console.error('ghostty_spawn falhou', err)
      }
    }
    void start()

    const ro = new ResizeObserver(scheduleFrame)
    ro.observe(node)
    window.addEventListener('resize', scheduleFrame)

    window.addEventListener('scroll', scheduleFrame, true)

    return () => {
      disposed = true
      ro.disconnect()
      window.removeEventListener('resize', scheduleFrame)
      window.removeEventListener('scroll', scheduleFrame, true)
      scheduleFrameRef.current = null
      pushFrameNowRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)

      // exatamente o bug "o terminal reseta ao voltar". A surface segue viva no

      void ghosttySetHidden(surfaceId, true)
    }
  }, [surfaceId])

  // explicitamente em dois casos:
  //   1. o placeholder saiu do viewport (scroll / troca de aba) — IntersectionObserver;

  //      qualquer Radix Dialog aberto ([role="dialog"][data-state="open"]), o que

  useEffect(() => {
    const node = placeholderRef.current
    if (!node) return

    let intersecting = true
    let lastHidden: boolean | null = null
    let lastFocused: boolean | null = null

    const applyHidden = () => {
      const hidden = !activeRef.current || !intersecting || isOverlayPresent()

      if (hidden !== lastHidden) {
        if (!hidden) pushFrameNowRef.current?.()
        lastHidden = hidden
        void ghosttySetHidden(surfaceId, hidden)
      }

      const focused = !hidden
      if (focused !== lastFocused) {
        lastFocused = focused
        void ghosttySetFocus(surfaceId, focused)
      }
    }
    reevaluateVisibilityRef.current = applyHidden

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) intersecting = entry.isIntersecting
        applyHidden()
      },
      { threshold: 0 },
    )
    io.observe(node)

    const unsubscribeOverlayPresence = subscribeOverlayPresence(applyHidden)

    return () => {
      io.disconnect()
      unsubscribeOverlayPresence()
      reevaluateVisibilityRef.current = null
    }
  }, [surfaceId])

  useEffect(() => {
    activeRef.current = active
    reevaluateVisibilityRef.current?.()
  }, [active])

  useEffect(() => {
    let stopped = false
    const iv = window.setInterval(async () => {
      if (stopped) return

      // backend e o comando reportaria "saiu" (ausente), fechando o pane novo.
      if (!spawnedRef.current) return
      try {
        const exited = await ghosttySurfaceExited(surfaceId)
        if (exited && !stopped) {
          stopped = true
          window.clearInterval(iv)
          onExitRef.current?.()
        }
      } catch {}
    }, EXIT_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(iv)
    }
  }, [surfaceId])

  return (
    <div
      ref={placeholderRef}
      style={{
        position: 'absolute',
        inset: 0,
        visibility: active ? 'visible' : 'hidden',
        pointerEvents: active ? 'auto' : 'none',
      }}
      data-ghostty-surface={surfaceId}
    />
  )
}
