import type { UnlistenFn } from '@tauri-apps/api/event'

export function listenerCleanup(
  pending: Promise<UnlistenFn>,
  onError: (cause: unknown) => void,
): () => void {
  let unlisten: UnlistenFn | null = null
  let gone = false
  let stopped = false
  const stop = () => {
    if (stopped || !unlisten) return
    stopped = true
    try {
      void Promise.resolve(unlisten() as unknown).catch(onError)
    } catch (cause) {
      onError(cause)
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
