import { useEffect, useRef } from 'react'

/**
 * Runs `callback` now (or after `startDelayMs`) and then every `intervalMs` while `enabled`.
 * `isCancelled` turns true once the effect is torn down, so an async tick that resolves late can
 * skip its state update.
 */
export function usePolling(
  callback: (isCancelled: () => boolean) => void,
  intervalMs: number,
  enabled = true,
  startDelayMs = 0,
): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null
    const isCancelled = () => cancelled
    const tick = () => savedCallback.current(isCancelled)
    const start = () => {
      tick()
      interval = setInterval(tick, intervalMs)
    }
    const startupDelay = startDelayMs > 0 ? setTimeout(start, startDelayMs) : null
    if (startupDelay === null) start()
    return () => {
      cancelled = true
      if (startupDelay !== null) clearTimeout(startupDelay)
      if (interval !== null) clearInterval(interval)
    }
  }, [intervalMs, enabled, startDelayMs])
}
