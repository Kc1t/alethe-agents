import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MountQueue = typeof import('./mountQueue')

// The queue keeps module-level state (activeMounts, waiters), so each test
// re-imports a fresh copy. Fake timers are installed before any acquire so
// the 4s escape-hatch timeout never fires unless a test advances the clock.
let acquireMountSlot: MountQueue['acquireMountSlot']

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  ;({ acquireMountSlot } = await import('./mountQueue'))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Tracks whether a promise has resolved without awaiting it. */
function track(promise: Promise<unknown>) {
  const state = { resolved: false }
  void promise.then(() => {
    state.resolved = true
  })
  return state
}

/** Lets pending promise callbacks run without advancing timers. */
const flushMicrotasks = () => Promise.resolve()

describe('acquireMountSlot', () => {
  it('grants the first two slots immediately', async () => {
    const first = track(acquireMountSlot())
    const second = track(acquireMountSlot())
    await flushMicrotasks()
    expect(first.resolved).toBe(true)
    expect(second.resolved).toBe(true)
  })

  it('does not grant a third slot while both are held', async () => {
    await acquireMountSlot()
    await acquireMountSlot()

    const third = track(acquireMountSlot())
    await flushMicrotasks()
    expect(third.resolved).toBe(false)
  })

  it('grants a queued waiter when a held slot is released', async () => {
    const release = await acquireMountSlot()
    await acquireMountSlot()

    const third = track(acquireMountSlot())
    await flushMicrotasks()
    expect(third.resolved).toBe(false)

    release()
    await flushMicrotasks()
    expect(third.resolved).toBe(true)
  })

  it('wakes waiters in FIFO order', async () => {
    const release = await acquireMountSlot()
    await acquireMountSlot()

    const firstWaiter = track(acquireMountSlot())
    const secondWaiter = track(acquireMountSlot())
    await flushMicrotasks()

    release()
    await flushMicrotasks()
    expect(firstWaiter.resolved).toBe(true)
    expect(secondWaiter.resolved).toBe(false)
  })

  it('ignores a second release of the same slot', async () => {
    const release = await acquireMountSlot()
    await acquireMountSlot()

    release()
    release() // must not free an extra slot

    // Only one slot was freed: the next acquire takes it, the one after queues.
    const third = track(acquireMountSlot())
    const fourth = track(acquireMountSlot())
    await flushMicrotasks()
    expect(third.resolved).toBe(true)
    expect(fourth.resolved).toBe(false)
  })

  it('grants a stuck waiter after the timeout and drops it from the queue', async () => {
    const release = await acquireMountSlot()
    await acquireMountSlot()

    const stuck = track(acquireMountSlot())
    await flushMicrotasks()
    expect(stuck.resolved).toBe(false)

    vi.advanceTimersByTime(4000)
    await flushMicrotasks()
    expect(stuck.resolved).toBe(true)

    // The timed-out waiter must have left the queue: releasing a real slot
    // goes to the next waiter instead of double-granting the stale one.
    const next = track(acquireMountSlot())
    await flushMicrotasks()
    expect(next.resolved).toBe(false)

    release()
    await flushMicrotasks()
    expect(next.resolved).toBe(true)
  })
})
