import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PausableTimer } from './pausableTimer'

describe('PausableTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires once the armed time has run', () => {
    const fire = vi.fn()
    const timer = new PausableTimer(fire)
    timer.arm(1000)
    vi.advanceTimersByTime(999)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('stops counting while paused and runs only the rest after resume', () => {
    const fire = vi.fn()
    const timer = new PausableTimer(fire)
    timer.arm(1000)
    vi.advanceTimersByTime(400)
    timer.pause()
    vi.advanceTimersByTime(10_000)
    expect(fire).not.toHaveBeenCalled()
    timer.resume()
    vi.advanceTimersByTime(599)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('arming while paused waits for the resume', () => {
    const fire = vi.fn()
    const timer = new PausableTimer(fire, true)
    timer.arm(500)
    vi.advanceTimersByTime(5_000)
    expect(fire).not.toHaveBeenCalled()
    timer.resume()
    vi.advanceTimersByTime(500)
    expect(fire).toHaveBeenCalledTimes(1)
  })

  it('re-arming replaces the previous deadline, and clear cancels it', () => {
    const fire = vi.fn()
    const timer = new PausableTimer(fire)
    timer.arm(100)
    timer.arm(1000)
    vi.advanceTimersByTime(500)
    expect(fire).not.toHaveBeenCalled()
    timer.clear()
    vi.advanceTimersByTime(5_000)
    expect(fire).not.toHaveBeenCalled()
    timer.resume()
    vi.advanceTimersByTime(5_000)
    expect(fire).not.toHaveBeenCalled()
  })
})
