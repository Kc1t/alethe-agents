import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePolling } from './usePolling'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePolling', () => {
  it('ticks immediately and then on every interval', () => {
    const callback = vi.fn()
    renderHook(() => usePolling(callback, 1000))
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3000)
    expect(callback).toHaveBeenCalledTimes(4)
  })

  it('waits for the start delay before the first tick', () => {
    const callback = vi.fn()
    renderHook(() => usePolling(callback, 1000, true, 1500))
    vi.advanceTimersByTime(1499)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('schedules nothing while disabled', () => {
    const callback = vi.fn()
    renderHook(() => usePolling(callback, 1000, false))
    vi.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('stops and reports cancellation after unmount', () => {
    let isCancelled: (() => boolean) | undefined
    const callback = vi.fn((cancelled: () => boolean) => {
      isCancelled = cancelled
    })
    const { unmount } = renderHook(() => usePolling(callback, 1000))
    expect(isCancelled?.()).toBe(false)
    unmount()
    expect(isCancelled?.()).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('clears a pending start delay on unmount', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => usePolling(callback, 1000, true, 1500))
    unmount()
    vi.advanceTimersByTime(5000)
    expect(callback).not.toHaveBeenCalled()
  })

  it('always calls the latest callback', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ callback }) => usePolling(callback, 1000), {
      initialProps: { callback: first },
    })
    rerender({ callback: second })
    vi.advanceTimersByTime(1000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })
})
