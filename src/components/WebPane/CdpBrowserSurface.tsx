import { isTauri } from '@tauri-apps/api/core'
import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import {
  type BrowserFrame,
  browserPaneClose,
  browserPaneCloseTarget,
  browserPaneKey,
  browserPaneMouse,
  browserPaneOpen,
  browserPaneReload,
  browserPaneResize,
  browserPaneSetStreaming,
  browserPaneTargets,
  browserPaneWatch,
  type BrowserTarget,
  listenBrowserPaneFrames,
  recordFrontendError,
} from '../../lib/tauri'
import { isAppShortcut, modifiersOf, mouseButtonOf, toKeyInput, toPageCoords } from './cdpInput'
import styles from './WebPane.module.css'

type CdpBrowserSurfaceProps = {
  paneId: string
  url: string
  reloadKey: number
  visible: boolean
  /** Attach to this existing tab instead of opening a new one. */
  watchTargetId?: string
}

const RESIZE_DEBOUNCE_MS = 180
const TARGET_POLL_MS = 3000

function decodeJpeg(base64: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: 'image/jpeg' })
}

export function CdpBrowserSurface({
  paneId,
  url,
  reloadKey,
  visible,
  watchTargetId,
}: CdpBrowserSurfaceProps) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<BrowserFrame | null>(null)
  const readyRef = useRef(false)
  const paintedRef = useRef(false)
  const [error, setError] = useState('')
  const [painted, setPainted] = useState(false)
  const [targets, setTargets] = useState<BrowserTarget[]>([])
  const [activeTarget, setActiveTarget] = useState('')
  // useT returns a fresh function every render. Depending on it would tear the pane down and
  // reopen it on every repaint, which never settles into a first frame.
  const failedLabelRef = useRef(t('webPane.cdpFailed'))
  failedLabelRef.current = t('webPane.cdpFailed')

  const measure = useCallback(() => {
    const host = hostRef.current
    if (!host) return { width: 1, height: 1 }
    const rect = host.getBoundingClientRect()
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    }
  }, [])

  useEffect(() => {
    if (!url || !isTauri()) return

    let disposed = false
    let unlisten: (() => void) | null = null
    let pending: BrowserFrame | null = null
    let decoding = false
    readyRef.current = false
    paintedRef.current = false
    setPainted(false)
    setError('')

    const fail = (stage: string, cause: unknown) => {
      const detail = `${stage}: ${cause instanceof Error ? cause.message : String(cause)}`
      if (import.meta.env.DEV) console.error('[Alethe][browser-cdp]', detail)
      void recordFrontendError(detail, null, 'browser-cdp.surface')
      if (!disposed) setError(failedLabelRef.current)
    }

    // Frames arrive faster than a canvas can decode them. Keeping only the newest one drops the
    // backlog instead of rendering a lagging queue of stale frames.
    const paint = async () => {
      if (decoding || !pending || disposed) return
      decoding = true
      const frame = pending
      pending = null
      try {
        const bitmap = await createImageBitmap(decodeJpeg(frame.data))
        const canvas = canvasRef.current
        if (!disposed && canvas) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
          // Only the first frame changes state; repainting must not re-render the tree.
          if (!paintedRef.current) {
            paintedRef.current = true
            setPainted(true)
          }
        }
        bitmap.close()
      } catch (cause) {
        fail('paint', cause)
      } finally {
        decoding = false
        if (pending) void paint()
      }
    }

    const start = async () => {
      const size = measure()
      try {
        unlisten = await listenBrowserPaneFrames(paneId, (frame) => {
          frameRef.current = frame
          pending = frame
          void paint()
        })
        if (disposed) {
          unlisten()
          unlisten = null
          return
        }
        if (watchTargetId) {
          await browserPaneWatch(paneId, watchTargetId, size.width, size.height)
          if (disposed) return
          readyRef.current = true
          setActiveTarget(watchTargetId)
        } else {
          const info = await browserPaneOpen(paneId, url, size.width, size.height)
          if (disposed) return
          readyRef.current = true
          setActiveTarget(info.targetId)
        }
      } catch (cause) {
        fail('open', cause)
      }
    }

    void start()

    return () => {
      disposed = true
      readyRef.current = false
      unlisten?.()
      void browserPaneClose(paneId).catch(() => {})
    }
  }, [paneId, url, watchTargetId, measure])

  // Reload keeps the tab and asks the page to come back without its cache. Tearing the pane down
  // and opening a new tab would land on the same cached copy, which is what reload is meant to escape.
  const appliedReloadRef = useRef(reloadKey)
  useEffect(() => {
    if (appliedReloadRef.current === reloadKey) return
    appliedReloadRef.current = reloadKey
    if (!readyRef.current || !isTauri()) return
    void browserPaneReload(paneId).catch(() => {})
  }, [paneId, reloadKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !isTauri()) return
    let timer: number | null = null
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!readyRef.current) return
        const size = measure()
        void browserPaneResize(paneId, size.width, size.height).catch(() => {})
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(host)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [paneId, measure])

  useEffect(() => {
    if (!readyRef.current || !isTauri()) return
    const size = measure()
    void browserPaneSetStreaming(paneId, visible, size.width, size.height).catch(() => {})
  }, [paneId, visible, measure, painted])

  // An agent driving the shared browser opens its own tabs. Listing them is what turns the pane
  // from "my page" into a window onto whatever the agent is doing.
  useEffect(() => {
    if (!visible || !isTauri()) return
    let cancelled = false
    const refresh = async () => {
      const list = await browserPaneTargets().catch(() => [])
      if (!cancelled) setTargets(list)
    }
    void refresh()
    const timer = window.setInterval(refresh, TARGET_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [visible, painted])

  const closeTarget = useCallback(async (targetId: string) => {
    await browserPaneCloseTarget(targetId).catch(() => {})
    setTargets((current) => current.filter((target) => target.targetId !== targetId))
  }, [])

  const watch = useCallback(
    async (targetId: string) => {
      const size = measure()
      await browserPaneWatch(paneId, targetId, size.width, size.height).catch(() => {})
      setActiveTarget(targetId)
    },
    [paneId, measure],
  )

  const sendMouse = useCallback(
    (
      kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel',
      event: React.MouseEvent<HTMLCanvasElement> | React.WheelEvent<HTMLCanvasElement>,
      extra: { deltaX?: number; deltaY?: number } = {},
    ) => {
      const canvas = canvasRef.current
      const frame = frameRef.current
      if (!canvas || !frame || !readyRef.current) return
      const rect = canvas.getBoundingClientRect()
      const point = toPageCoords({ clientX: event.clientX, clientY: event.clientY }, rect, frame)
      const button = 'button' in event ? mouseButtonOf(event.button) : 'none'
      void browserPaneMouse(paneId, {
        kind,
        x: point.x,
        y: point.y,
        button: kind === 'mouseMoved' || kind === 'mouseWheel' ? 'none' : button,
        clickCount: kind === 'mousePressed' || kind === 'mouseReleased' ? 1 : 0,
        modifiers: modifiersOf(event),
        ...extra,
      }).catch(() => {})
    },
    [paneId],
  )

  const sendKey = useCallback(
    (kind: 'keyDown' | 'keyUp', event: React.KeyboardEvent<HTMLCanvasElement>) => {
      if (!readyRef.current) return
      if (isAppShortcut(event)) return
      event.preventDefault()
      void browserPaneKey(paneId, toKeyInput(kind, event)).catch(() => {})
    },
    [paneId],
  )

  return (
    <div ref={hostRef} className={styles.cdpHost}>
      {targets.length > 1 ? (
        <div className={styles.cdpTabs} role="tablist" aria-label={t('webPane.cdpTabs')}>
          {targets.map((target) => (
            <div
              key={target.targetId}
              className={`${styles.cdpTab} ${
                target.targetId === activeTarget ? styles.cdpTabActive : ''
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={target.targetId === activeTarget}
                className={styles.cdpTabLabel}
                onClick={() => void watch(target.targetId)}
                title={target.url}
              >
                {target.title || target.url}
              </button>
              <button
                type="button"
                aria-label={t('webPane.cdpCloseTab')}
                className={styles.cdpTabClose}
                onClick={() => void closeTarget(target.targetId)}
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className={styles.cdpCanvas}
        tabIndex={0}
        aria-label={t('webPane.cdpSurface')}
        onMouseDown={(event) => {
          canvasRef.current?.focus()
          sendMouse('mousePressed', event)
        }}
        onMouseUp={(event) => sendMouse('mouseReleased', event)}
        onMouseMove={(event) => sendMouse('mouseMoved', event)}
        onWheel={(event) =>
          sendMouse('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY })
        }
        onKeyDown={(event) => sendKey('keyDown', event)}
        onKeyUp={(event) => sendKey('keyUp', event)}
        onContextMenu={(event) => event.preventDefault()}
      />
      {!painted && !error ? (
        <div className={styles.cdpStatus}>{t('webPane.cdpLoading')}</div>
      ) : null}
      {error ? <div className={styles.cdpStatus}>{error}</div> : null}
    </div>
  )
}
