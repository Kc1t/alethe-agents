import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createThrottle } from './throttle'

describe('createThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs at once, then at most once per interval with the latest call', () => {
    const run = vi.fn()
    const throttle = createThrottle(100, run)
    throttle.schedule()
    expect(run).toHaveBeenCalledTimes(1)
    throttle.schedule()
    throttle.schedule()
    expect(run).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('stops after dispose', () => {
    const run = vi.fn()
    const throttle = createThrottle(100, run)
    throttle.schedule()
    throttle.schedule()
    throttle.dispose()
    vi.advanceTimersByTime(500)
    expect(run).toHaveBeenCalledTimes(1)
  })
})
