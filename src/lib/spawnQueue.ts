let maxConcurrentSpawns = 3

let active = 0

type SpawnWaiter = {
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (acquired: boolean) => void
}

const waiters: SpawnWaiter[] = []

function resumeWaiter(waiter: SpawnWaiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
  active++
  waiter.resolve(true)
}

function drain(limit = maxConcurrentSpawns): void {
  while (active < limit && waiters.length > 0) {
    const waiter = waiters.shift()
    if (waiter) resumeWaiter(waiter)
  }
}

export function setMaxConcurrentSpawns(n: number): void {
  const next = Math.max(1, Math.round(n))
  if (next === maxConcurrentSpawns) return
  maxConcurrentSpawns = next
  drain()
  notify()
}

export type SpawnQueueSnapshot = {
  active: number
  queued: number
}

type Listener = (snapshot: SpawnQueueSnapshot) => void
const listeners = new Set<Listener>()

function notify(): void {
  const snapshot = {
    active,
    queued: waiters.length,
  }
  for (const l of listeners) l(snapshot)
}

export function subscribeSpawnQueue(l: Listener): () => void {
  listeners.add(l)
  l(getSpawnQueueSnapshot())
  return () => listeners.delete(l)
}

export function getSpawnQueueSnapshot(): SpawnQueueSnapshot {
  return {
    active,
    queued: waiters.length,
  }
}

export function acquireSpawnSlot(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (active < maxConcurrentSpawns) {
    active++
    notify()
    return Promise.resolve(true)
  }

  return new Promise<boolean>((resolve) => {
    const waiter: SpawnWaiter = {
      signal,
      resolve,
    }
    if (signal) {
      waiter.onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index === -1) return
        waiters.splice(index, 1)
        resolve(false)
        notify()
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    }
    waiters.push(waiter)
    if (signal?.aborted) {
      waiter.onAbort?.()
    } else {
      notify()
    }
  })
}

export function releaseSpawnSlot(): void {
  active = Math.max(0, active - 1)
  drain()
  notify()
}
