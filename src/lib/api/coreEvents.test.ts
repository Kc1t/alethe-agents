import { afterEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  createWebSocketStream: vi.fn(),
  invalidateCoreSessionToken: vi.fn(),
}))

vi.mock('./transport', () => transport)

import { type CoreSyncEvent, subscribeCoreSyncEvents } from './coreEvents'

class FakeSocket {
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()

  emitMessage(data: unknown) {
    this.onmessage?.({ data })
  }

  emitClose() {
    this.onclose?.()
  }
}

const snapshot: CoreSyncEvent = {
  sequence: 1,
  reason: 'connected',
  activeProfileId: 'default',
  profiles: [{ id: 'default', name: 'Default', created_at_ms: 1, last_used_at_ms: 2 }],
  activeProjectsRevision: 'revision-a',
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('subscribeCoreSyncEvents', () => {
  it('delivers a valid synchronization snapshot', async () => {
    const socket = new FakeSocket()
    const listener = vi.fn()
    transport.createWebSocketStream.mockResolvedValue(socket as unknown as WebSocket)

    const unsubscribe = subscribeCoreSyncEvents(listener)
    await vi.waitFor(() => expect(transport.createWebSocketStream).toHaveBeenCalledOnce())
    socket.emitMessage(JSON.stringify(snapshot))

    expect(listener).toHaveBeenCalledWith(snapshot)
    unsubscribe()
  })

  it('ignores malformed and incomplete frames', async () => {
    const socket = new FakeSocket()
    const listener = vi.fn()
    transport.createWebSocketStream.mockResolvedValue(socket as unknown as WebSocket)

    const unsubscribe = subscribeCoreSyncEvents(listener)
    await vi.waitFor(() => expect(transport.createWebSocketStream).toHaveBeenCalledOnce())
    socket.emitMessage('{not-json')
    socket.emitMessage(JSON.stringify({ sequence: 2, profiles: [] }))

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('invalidates the session and reconnects after the stream closes', async () => {
    vi.useFakeTimers()
    const first = new FakeSocket()
    const second = new FakeSocket()
    transport.createWebSocketStream
      .mockResolvedValueOnce(first as unknown as WebSocket)
      .mockResolvedValueOnce(second as unknown as WebSocket)

    const unsubscribe = subscribeCoreSyncEvents(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.createWebSocketStream).toHaveBeenCalledOnce()
    first.emitClose()

    expect(transport.invalidateCoreSessionToken).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.createWebSocketStream).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('drops a duplicated or out-of-order sequence on the same connection', async () => {
    const socket = new FakeSocket()
    const listener = vi.fn()
    transport.createWebSocketStream.mockResolvedValue(socket as unknown as WebSocket)

    const unsubscribe = subscribeCoreSyncEvents(listener)
    await vi.waitFor(() => expect(transport.createWebSocketStream).toHaveBeenCalledOnce())

    socket.emitMessage(JSON.stringify({ ...snapshot, sequence: 5 }))
    socket.emitMessage(JSON.stringify({ ...snapshot, sequence: 5 })) // duplicate
    socket.emitMessage(JSON.stringify({ ...snapshot, sequence: 3 })) // out of order

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sequence: 5 }))
    unsubscribe()
  })

  it('resets the sequence baseline on reconnect, even to a lower sequence from a restarted core', async () => {
    vi.useFakeTimers()
    const first = new FakeSocket()
    const second = new FakeSocket()
    transport.createWebSocketStream
      .mockResolvedValueOnce(first as unknown as WebSocket)
      .mockResolvedValueOnce(second as unknown as WebSocket)
    const listener = vi.fn()

    const unsubscribe = subscribeCoreSyncEvents(listener)
    await vi.advanceTimersByTimeAsync(0)
    first.emitMessage(JSON.stringify({ ...snapshot, sequence: 500 }))
    first.emitClose()
    await vi.advanceTimersByTimeAsync(500)

    // A restarted core resets its own sequence counter to a low number; the
    // reconnected client must accept it instead of treating it as stale.
    second.emitMessage(JSON.stringify({ ...snapshot, sequence: 1, reason: 'connected' }))

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 1 }))
    unsubscribe()
  })
})
