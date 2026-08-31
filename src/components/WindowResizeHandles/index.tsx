import { getCurrentWindow } from '@tauri-apps/api/window'
import { useEffect, useState } from 'react'

import styles from './WindowResizeHandles.module.css'

/** Matches `@tauri-apps/api` window resize directions (not re-exported as a public type). */
type ResizeDirection =
  'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West'

/**
 * Undecorated Tauri windows (`decorations: false`) have no OS resize border on
 * most platforms (notably Linux). These thin edge/corner hit targets call
 * `startResizeDragging` so the window can be resized by dragging the frame.
 */
const HANDLES: { className: string; direction: ResizeDirection }[] = [
  { className: styles.n, direction: 'North' },
  { className: styles.s, direction: 'South' },
  { className: styles.e, direction: 'East' },
  { className: styles.w, direction: 'West' },
  { className: styles.ne, direction: 'NorthEast' },
  { className: styles.nw, direction: 'NorthWest' },
  { className: styles.se, direction: 'SouthEast' },
  { className: styles.sw, direction: 'SouthWest' },
]

export function WindowResizeHandles() {
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    const win = getCurrentWindow()
    let disposed = false

    const sync = async () => {
      try {
        const [maximized, fullscreen] = await Promise.all([win.isMaximized(), win.isFullscreen()])
        if (!disposed) setEnabled(!maximized && !fullscreen)
      } catch {
        if (!disposed) setEnabled(true)
      }
    }

    void sync()
    const unlistenPromise = win.onResized(() => {
      void sync()
    })

    return () => {
      disposed = true
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [])

  if (!enabled) return null

  return (
    <div className={styles.root} aria-hidden="true">
      {HANDLES.map(({ className, direction }) => (
        <div
          key={direction}
          className={`${styles.handle} ${className}`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            void getCurrentWindow().startResizeDragging(direction)
          }}
        />
      ))}
    </div>
  )
}
