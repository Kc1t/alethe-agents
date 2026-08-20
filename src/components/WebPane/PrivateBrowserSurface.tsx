import { isTauri } from '@tauri-apps/api/core'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { Webview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { isOverlayPresent, subscribeOverlayPresence } from '../../lib/overlayPresence'
import {
  type SurfaceRect,
  surfaceRectsEqual,
  toPhysicalRect,
  visibleRectOf,
} from '../../lib/surfaceGeometry'
import { recordFrontendError } from '../../lib/tauri'
import { isSurfaceDebugEnabled, type SurfaceDebugInfo } from './surfaceDebug'
import { SurfaceDebugPanel } from './SurfaceDebugPanel'
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
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(visible)
  const hiddenEvictionDelayRef = useRef(hiddenEvictionDelayMs)
  const reevaluateRef = useRef<(() => void) | null>(null)
  // Read through a ref so changing the UI language does not tear down every native webview.
  const startFailedRef = useRef(t('webPane.privateStartFailed'))
  startFailedRef.current = t('webPane.privateStartFailed')
  const [surfaceState, setSurfaceState] = useState<SurfaceState>('loading')
  const [error, setError] = useState('')
  const [debug, setDebug] = useState<SurfaceDebugInfo | null>(null)

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

    const debugEnabled = isSurfaceDebugEnabled()

    let disposed = false
    let created = false
    let intersecting = true
    let shown: boolean | null = null
    let lastRect: SurfaceRect | null = null
    let frame: number | null = null
    let evictionTimer: number | null = null
    let webview: Webview | null = null
    let label = ''
    let lastFailure = ''
    let unlistenCreated: (() => void) | null = null
    let unlistenError: (() => void) | null = null
    let unlistenScale: (() => void) | null = null
    setSurfaceState('loading')
    setError('')

    const reportFailure = (stage: string, cause: unknown) => {
      const detail = `${stage}: ${cause instanceof Error ? cause.message : String(cause)}`
      if (detail === lastFailure) return
      lastFailure = detail
      if (import.meta.env.DEV) console.error('[Alethe][private-browser]', detail)
      void recordFrontendError(detail, null, 'private-browser.geometry')
    }

    const readRect = (): { css: SurfaceRect; physical: SurfaceRect; ratio: number } | null => {
      const css = visibleRectOf(node)
      if (!css) return null
      const ratio = window.devicePixelRatio || 1
      return { css, physical: toPhysicalRect(css, ratio), ratio }
    }

    const publishDebug = (state: Partial<SurfaceDebugInfo>) => {
      if (!debugEnabled || disposed) return
      setDebug((previous) => ({
        css: null,
        physical: null,
        ratio: window.devicePixelRatio || 1,
        visible: visibleRef.current,
        intersecting,
        occluded: isOverlayPresent(),
        label,
        failure: lastFailure,
        ...previous,
        ...state,
      }))
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

    const startWebview = (initial: SurfaceRect) => {
      if (disposed || webview) return

      // Every recreation gets a new label so a closing native surface cannot
      // collide with the replacement during StrictMode or rapid modal changes.
      label = `browser-${paneId}-${reloadKey}-${crypto.randomUUID()}`

      const instance = new Webview(getCurrentWindow(), label, {
        url,
        x: initial.x,
        y: initial.y,
        width: initial.width,
        height: initial.height,
        incognito: true,
        focus: false,
        javascriptDisabled: !javascriptEnabled,
        // WebView2-only options; other platforms ignore them silently.
        generalAutofillEnabled: false,
        zoomHotkeysEnabled: false,
      })
      webview = instance
      lastRect = initial

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
          const detail = String(event.payload || startFailedRef.current)
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

    /** Returns false when the move failed, so the caller keeps the surface hidden and retries. */
    const applyRect = async (target: SurfaceRect, instance: Webview): Promise<boolean> => {
      if (surfaceRectsEqual(lastRect, target)) return true
      try {
        await Promise.all([
          instance.setPosition(new PhysicalPosition(target.x, target.y)),
          instance.setSize(new PhysicalSize(target.width, target.height)),
        ])
        // Only latch after the move lands, otherwise a failure is remembered as applied and the
        // surface stays wherever it was until the rect happens to change again.
        lastRect = target
        return true
      } catch (cause) {
        reportFailure('move', cause)
        return false
      }
    }

    const sync = async () => {
      frame = null
      if (disposed) return

      const measured = readRect()
      const shouldShow =
        visibleRef.current && intersecting && !isOverlayPresent() && measured !== null
      publishDebug({ css: measured?.css ?? null, physical: measured?.physical ?? null })

      if (!webview) {
        if (shouldShow && measured) startWebview(measured.physical)
        return
      }
      if (!created) return

      if (!shouldShow) {
        if (shown !== false) {
          shown = false
          // Forget the applied rect: the surface must be repositioned before it is shown again,
          // otherwise it reappears wherever it was left.
          lastRect = null
          try {
            await webview.hide()
          } catch (cause) {
            reportFailure('hide', cause)
          }
        }
        scheduleEviction()
        return
      }

      clearEvictionTimer()
      if (!measured) return
      if (!(await applyRect(measured.physical, webview))) {
        scheduleSync()
        return
      }
      if (shown !== true) {
        shown = true
        try {
          await webview.show()
        } catch (cause) {
          reportFailure('show', cause)
          shown = false
        }
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
    // Moving to a monitor with a different scale changes physical pixels without moving the DOM.
    void getCurrentWindow()
      .onScaleChanged(scheduleSync)
      .then((unlisten) => {
        if (disposed) unlisten()
        else unlistenScale = unlisten
      })
      .catch(() => {})
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
      unlistenScale?.()
      closeWebview()
    }
  }, [javascriptEnabled, paneId, reloadKey, url, zoom])

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
      {debug ? <SurfaceDebugPanel info={debug} /> : null}
    </div>
  )
}
