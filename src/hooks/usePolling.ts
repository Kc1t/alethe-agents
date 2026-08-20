import { useEffect, useRef } from 'react'

export function usePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (!enabled) return
    const tick = () => savedCallback.current()
    tick()
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
}
