import { isTauri } from '@tauri-apps/api/core'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { Webview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { isOverlayPresent, subscribeOverlayPresence } from '../../lib/overlayPresence'
import { recordFrontendError } from '../../lib/tauri'
import styles from './WebPane.module.css'

type PrivateBrowserSurfaceProps = {
  paneId: string
  url: string
  title: string
  reloadKey: number
  javascriptEnabled: boolean
  hiddenEvictionDelayMs: number | null
  zoom: number
  visible: boolean
}

type SurfaceState = 'loading' | 'ready' | 'error'

type SurfaceRect = {
  x: number
  y: number
  width: number
  height: number
}

function rectsEqual(left: SurfaceRect | null, right: SurfaceRect): boolean {
  if (!left) return false
  return (
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
  )
}

export function PrivateBrowserSurface({
  paneId,
  url,
  title,
  reloadKey,
  javascriptEnabled,
  hiddenEvictionDelayMs,
  zoom,
  visible,
}: PrivateBrowserSurfaceProps) {
  const t = useT()
  const privateStartFailed = t('webPane.privateStartFailed')
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(visible)
  const hiddenEvictionDelayRef = useRef(hiddenEvictionDelayMs)
  const reevaluateRef = useRef<(() => void) | null>(null)
  const [surfaceState, setSurfaceState] = useState<SurfaceState>('loading')
  const [error, setError] = useState('')

  useLayoutEffect(() => {
    visibleRef.current = visible
    reevaluateRef.current?.()
  }, [visible])

  useEffect(() => {
    hiddenEvictionDelayRef.current = hiddenEvictionDelayMs
    reevaluateRef.current?.()
  }, [hiddenEvictionDelayMs])

  useEffect(() => {
    const node = placeholderRef.current
    if (!node || !url || !isTauri()) return

    let disposed = false
    let created = false
    let intersecting = true
    let shown: boolean | null = null
    let lastRect: SurfaceRect | null = null
    let frame: number | null = null
    let evictionTimer: number | null = null
    let webview: Webview | null = null
    let unlistenCreated: (() => void) | null = null
    let unlistenError: (() => void) | null = null
    setSurfaceState('loading')
    setError('')

    const readRect = (): SurfaceRect | null => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return null
      // Child webviews are placed in physical pixels. getBoundingClientRect reports CSS
      // pixels, and devicePixelRatio folds in both display scaling and webview zoom, so the
      // two only coincide at ratio 1 — which is why this looked correct on unscaled displays.
      const ratio = window.devicePixelRatio || 1
      return {
        x: Math.round(rect.left * ratio),
        y: Math.round(rect.top * ratio),
        width: Math.round(rect.width * ratio),
        height: Math.round(rect.height * ratio),
      }
    }

    const clearEvictionTimer = () => {
      if (evictionTimer === null) return
      window.clearTimeout(evictionTimer)
      evictionTimer = null
    }

    const closeWebview = () => {
      clearEvictionTimer()
      const closing = webview
      webview = null
      created = false
      shown = null
      lastRect = null
      if (!closing) return
      if (!disposed) setSurfaceState('loading')
      void closing
        .hide()
        .catch(() => {})
        .then(() => closing.close().catch(() => {}))
    }

    const scheduleEviction = () => {
      if (evictionTimer !== null || !webview) return
      const delay = hiddenEvictionDelayRef.current
      if (delay === null) return
      evictionTimer = window.setTimeout(closeWebview, delay)
    }

    const startWebview = () => {
      if (disposed || webview) return
      const initialRect = readRect()
      if (!initialRect) return

      // Every recreation gets a new label so a closing native surface cannot
      // collide with the replacement during StrictMode or rapid modal changes.
      const label = `browser-${paneId}-${reloadKey}-${crypto.randomUUID()}`

      const instance = new Webview(getCurrentWindow(), label, {
        url,
        x: initialRect.x,
        y: initialRect.y,
        width: initialRect.width,
        height: initialRect.height,
        incognito: true,
        focus: false,
        javascriptDisabled: !javascriptEnabled,
        generalAutofillEnabled: false,
        zoomHotkeysEnabled: false,
      })
      webview = instance

      void instance
        .once('tauri://created', () => {
          if (disposed || webview !== instance) {
            void instance.close().catch(() => {})
            return
          }
          created = true
          setSurfaceState('ready')
          setError('')
          void instance.setZoom(zoom).catch(() => {})
          scheduleSync()
        })
        .then((unlisten) => {
          if (disposed) unlisten()
          else unlistenCreated = unlisten
        })

      void instance
        .once<string>('tauri://error', (event) => {
          if (disposed || webview !== instance) return
          const detail = String(event.payload || privateStartFailed)
          if (import.meta.env.DEV) console.error('[Alethe][private-browser]', detail)
          void recordFrontendError(detail, null, 'private-browser.create')
          setSurfaceState('error')
          setError(detail)
        })
        .then((unlisten) => {
          if (disposed) unlisten()
          else unlistenError = unlisten
        })
    }

    const sync = async () => {
      frame = null
      if (disposed) return
      if (!webview) {
        if (!visibleRef.current || !intersecting || isOverlayPresent()) return
        startWebview()
        return
      }
      if (!created) return
      const shouldShow = visibleRef.current && intersecting && !isOverlayPresent()
      if (!shouldShow) {
        if (shown !== false) {
          shown = false
          await webview.hide().catch(() => {})
        }
        scheduleEviction()
        return
      }

      clearEvictionTimer()

      const rect = readRect()
      if (!rect) return
      if (!rectsEqual(lastRect, rect)) {
        lastRect = rect
        await Promise.all([
          webview.setPosition(new PhysicalPosition(rect.x, rect.y)),
          webview.setSize(new PhysicalSize(rect.width, rect.height)),
        ]).catch(() => {})
      }
      if (shown !== true) {
        shown = true
        await webview.show().catch(() => {})
      }
    }

    const scheduleSync = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => void sync())
    }
    reevaluateRef.current = () => {
      clearEvictionTimer()
      scheduleSync()
    }

    const resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(node)
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        intersecting = entries.some((entry) => entry.isIntersecting)
        scheduleSync()
      },
      { threshold: 0 },
    )
    intersectionObserver.observe(node)
    const unsubscribeOverlayPresence = subscribeOverlayPresence(scheduleSync)
    window.addEventListener('resize', scheduleSync)
    window.addEventListener('scroll', scheduleSync, true)
    window.addEventListener('alethe:zoom-changed', scheduleSync)
    scheduleSync()

    return () => {
      disposed = true
      clearEvictionTimer()
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      unsubscribeOverlayPresence()
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', scheduleSync, true)
      window.removeEventListener('alethe:zoom-changed', scheduleSync)
      reevaluateRef.current = null
      if (frame !== null) window.cancelAnimationFrame(frame)
      unlistenCreated?.()
      unlistenError?.()
      closeWebview()
    }
  }, [javascriptEnabled, paneId, privateStartFailed, reloadKey, url, zoom])

  if (!isTauri()) {
    return (
      <iframe
        src={url}
        className={styles.frame}
        title={title}
        loading="lazy"
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        {...({ credentialless: '' } as Record<string, string>)}
      />
    )
  }

  return (
    <div ref={placeholderRef} className={styles.nativeSurface}>
      {surfaceState === 'loading' ? (
        <span>{t('webPane.privateStarting')}</span>
      ) : surfaceState === 'error' ? (
        <span className={styles.surfaceError} title={error}>
          {t('webPane.privateStartFailed')}
        </span>
      ) : null}
    </div>
  )
}
