import type { UnlistenFn } from '@tauri-apps/api/event'

/**
 * Cleanup for a Tauri listener, for an effect's teardown. It stops the listener even when it is
 * registered after the effect already went away, stops it at most once, and swallows a failed stop:
 * Tauri's unlisten is async and rejects when the listener is already gone (e.g. after a webview
 * reload), which would otherwise surface as an unhandled rejection.
 */
export function listenerCleanup(pending: Promise<UnlistenFn>): () => void {
  let unlisten: UnlistenFn | null = null
  let gone = false
  let stopped = false
  const stop = () => {
    if (stopped || !unlisten) return
    stopped = true
    try {
      // Typed as returning void, but Tauri's implementation returns a promise.
      void Promise.resolve(unlisten() as unknown).catch(() => undefined)
    } catch {
      // Already torn down.
    }
  }
  pending
    .then((fn) => {
      unlisten = fn
      if (gone) stop()
    })
    .catch(() => undefined)
  return () => {
    gone = true
    stop()
  }
}
