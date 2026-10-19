/** Leading-edge throttle with a trailing run, so the latest state always gets published. */
export function createThrottle(
  intervalMs: number,
  run: () => void,
): { schedule(): void; dispose(): void } {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const fire = () => {
    timer = null
    last = Date.now()
    if (!disposed) run()
  }
  return {
    schedule() {
      if (disposed || timer !== null) return
      const wait = last + intervalMs - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
