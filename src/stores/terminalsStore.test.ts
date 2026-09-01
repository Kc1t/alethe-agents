import { afterEach, describe, expect, it, vi } from 'vitest'

import { IO_TIMESTAMP_THROTTLE_MS, useTerminalsStore } from './terminalsStore'

describe('terminals runtime activity', () => {
  afterEach(() => {
    vi.useRealTimers()
    useTerminalsStore.getState().reset()
  })

  it('coalesces high-frequency PTY activity timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const store = useTerminalsStore.getState()
    store.registerPty('pty-1')
    const initialRuntime = useTerminalsStore.getState().byPtyId['pty-1']

    store.recordIo('pty-1')
    vi.advanceTimersByTime(IO_TIMESTAMP_THROTTLE_MS - 1)
    store.recordIo('pty-1')

    expect(useTerminalsStore.getState().byPtyId['pty-1']).toBe(initialRuntime)

    vi.advanceTimersByTime(1)
    store.recordIo('pty-1')

    const updatedRuntime = useTerminalsStore.getState().byPtyId['pty-1']
    expect(updatedRuntime).not.toBe(initialRuntime)
    expect(updatedRuntime.lastIoAt - initialRuntime.lastIoAt).toBe(IO_TIMESTAMP_THROTTLE_MS)
  })
})
