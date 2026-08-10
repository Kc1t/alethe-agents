import { isTauri } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { Webview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import styles from './WebPane.module.css'

type PrivateBrowserSurfaceProps = {
  paneId: string
  url: string
  title: string
  reloadKey: number
  javascriptEnabled: boolean
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
  zoom,
  visible,
}: PrivateBrowserSurfaceProps) {
  const t = useT()
  const privateStartFailed = t('webPane.privateStartFailed')
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(visible)
  const reevaluateRef = useRef<(() => void) | null>(null)
  const [surfaceState, setSurfaceState] = useState<SurfaceState>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    visibleRef.current = visible
    reevaluateRef.current?.()
  }, [visible])

  useEffect(() => {
    const node = placeholderRef.current
    if (!node || !url || !isTauri()) return

    let disposed = false
    let created = false
    let intersecting = true
    let shown: boolean | null = null
    let lastRect: SurfaceRect | null = null
    let frame: number | null = null
    let webview: Webview | null = null
    let unlistenCreated: (() => void) | null = null
    let unlistenError: (() => void) | null = null
    setSurfaceState('loading')
    setError('')

    const overlaysOpen = () =>
      document.querySelector('[role="dialog"][data-state="open"], [role="menu"]') !== null

    const readRect = (): SurfaceRect | null => {
      const rect = node.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return null
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }

    const label = `browser-${paneId}-${reloadKey}`

    const startWebview = () => {
      if (disposed || webview) return
      const initialRect = readRect()
      if (!initialRect) return

      webview = new Webview(getCurrentWindow(), label, {
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

      void webview
        .once('tauri://created', () => {
          if (disposed || !webview) {
            void webview?.close().catch(() => {})
            return
          }
          created = true
          setSurfaceState('ready')
          setError('')
          void webview.setZoom(zoom).catch(() => {})
          scheduleSync()
        })
        .then((unlisten) => {
          if (disposed) unlisten()
          else unlistenCreated = unlisten
        })

      void webview
        .once<string>('tauri://error', (event) => {
          if (disposed) return
          setSurfaceState('error')
          setError(String(event.payload || privateStartFailed))
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
        startWebview()
        return
      }
      if (!created) return
      const shouldShow = visibleRef.current && intersecting && !overlaysOpen()
      if (!shouldShow) {
        if (shown !== false) {
          shown = false
          await webview.hide().catch(() => {})
        }
        return
      }

      const rect = readRect()
      if (!rect) return
      if (!rectsEqual(lastRect, rect)) {
        lastRect = rect
        await Promise.all([
          webview.setPosition(new LogicalPosition(rect.x, rect.y)),
          webview.setSize(new LogicalSize(rect.width, rect.height)),
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
    reevaluateRef.current = scheduleSync

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
    const mutationObserver = new MutationObserver(scheduleSync)
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state', 'role'],
    })
    window.addEventListener('resize', scheduleSync)
    window.addEventListener('scroll', scheduleSync, true)
    window.addEventListener('alethe:zoom-changed', scheduleSync)
    scheduleSync()

    return () => {
      disposed = true
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', scheduleSync, true)
      window.removeEventListener('alethe:zoom-changed', scheduleSync)
      reevaluateRef.current = null
      if (frame !== null) window.cancelAnimationFrame(frame)
      unlistenCreated?.()
      unlistenError?.()
      void webview?.hide().catch(() => {})
      void webview?.close().catch(() => {})
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
