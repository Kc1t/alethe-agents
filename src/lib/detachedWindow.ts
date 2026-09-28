import type { WebviewWindow as WebviewWindowHandle } from '@tauri-apps/api/webviewWindow'

/**
 * Pops a single pane out of the main workspace into its own OS window. The new window loads the
 * same frontend bundle with `?detachedPane=<paneId>` in the URL; `main.tsx` reads that and renders
 * only that pane instead of the full app shell (see `DetachedPaneWindow`).
 */
const LABEL_PREFIX = 'detached-pane-'
const QUERY_PARAM = 'detachedPane'

/** Windows this session opened, keyed by pane id, so a second click focuses instead of duplicating. */
const openWindows = new Map<string, WebviewWindowHandle>()

export function detachedWindowLabel(paneId: string): string {
  return `${LABEL_PREFIX}${paneId}`
}

/** The pane id a window was opened for, read from its own URL at boot. Null in the main window. */
export function detachedPaneIdFromLocation(location: Location = window.location): string | null {
  return new URLSearchParams(location.search).get(QUERY_PARAM)
}

/**
 * Opens a standalone OS window showing just this pane, or focuses it if one is already open.
 * `onClosed` fires exactly once, whenever the window goes away (user closed it, crashed, or
 * failed to open at all) — the caller uses it to stop hiding the pane in the main grid.
 */
export async function openDetachedPaneWindow(
  paneId: string,
  title: string,
  onClosed: () => void,
): Promise<void> {
  const label = detachedWindowLabel(paneId)
  const existing = openWindows.get(label)
  if (existing) {
    await existing.setFocus()
    return
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const url = `index.html?${QUERY_PARAM}=${encodeURIComponent(paneId)}`
  const win = new WebviewWindow(label, {
    url,
    title,
    width: 760,
    height: 520,
    minWidth: 360,
    minHeight: 220,
  })
  openWindows.set(label, win)

  const finish = () => {
    if (openWindows.get(label) !== win) return
    openWindows.delete(label)
    onClosed()
  }
  void win.once('tauri://destroyed', finish)
  void win.once('tauri://error', finish)
}

/** Closes a pane's detached window, if one is open. The `onClosed` from `openDetachedPaneWindow` still fires. */
export async function closeDetachedPaneWindow(paneId: string): Promise<void> {
  const win = openWindows.get(detachedWindowLabel(paneId))
  // destroy(), not close(): skips the close-requested round trip (nothing listens for it on this
  // window anyway) and only needs the `allow-destroy` permission the main capability already has.
  await win?.destroy()
}
