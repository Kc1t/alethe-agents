// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  canUseSharedCoreTransport: vi.fn(async () => true),
  createWebSocketStream: vi.fn(),
  invalidateCoreSessionToken: vi.fn(),
  isTauriEnv: vi.fn(() => false),
  webApiFetch: vi.fn(),
}))

vi.mock('./transport', () => transport)

import {
  chunksAfterPtySnapshot,
  listenPtyActivity,
  listenPtyData,
  listenPtyResync,
  resizePty,
} from './pty'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly send = vi.fn()

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  message(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

const sockets: FakeWebSocket[] = []

async function flushSocketCreation(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await Promise.resolve()
    const socket = sockets[sockets.length - 1]
    if (socket?.onopen) return socket
  }
  throw new Error('PTY WebSocket was not created')
}

beforeEach(() => {
  vi.clearAllMocks()
  sockets.length = 0
  transport.createWebSocketStream.mockImplementation(async () => {
    const socket = new FakeWebSocket()
    sockets.push(socket)
    return socket as unknown as WebSocket
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('chunksAfterPtySnapshot', () => {
  it('drops events already represented by the atomic snapshot cursor', () => {
    expect(
      chunksAfterPtySnapshot(20, [
        { chunk: 'included', cursor: 20 },
        { chunk: 'new', cursor: 24 },
      ]),
    ).toEqual(['new'])
  })

  it('retains legacy events without a cursor to avoid a data gap', () => {
    expect(chunksAfterPtySnapshot(20, [{ chunk: 'legacy' }])).toEqual(['legacy'])
  })
})

describe('browser PTY stream', () => {
  it('namespaces sockets by profile and keeps activity separate from rendered data', async () => {
    const data: string[] = []
    const activity: string[] = []
    const dataSubscription = listenPtyData('same-id', (chunk) => data.push(chunk), 'profile-a')
    const firstSocket = await flushSocketCreation()
    firstSocket.open()
    const unlistenData = await dataSubscription
    const unlistenActivity = await listenPtyActivity(
      'same-id',
      (chunk) => activity.push(chunk),
      'profile-a',
    )

    firstSocket.message({ type: 'activity', chunk: 'background', cursor: 10 })
    firstSocket.message({ type: 'data', chunk: 'foreground', cursor: 20 })

    expect(activity).toEqual(['background'])
    expect(data).toEqual(['foreground'])
    expect(transport.createWebSocketStream).toHaveBeenCalledWith(
      '/api/pty/ws/same-id?profileId=profile-a',
    )

    const secondSubscription = listenPtyData('same-id', () => {}, 'profile-b')
    const secondSocket = await flushSocketCreation()
    secondSocket.open()
    const unlistenSecond = await secondSubscription
    expect(secondSocket).not.toBe(firstSocket)

    unlistenActivity()
    unlistenData()
    unlistenSecond()
  })

  it('sends resize once through an open socket without a REST duplicate', async () => {
    const subscription = listenPtyData('resize-id', () => {}, 'profile-a')
    const socket = await flushSocketCreation()
    socket.open()
    const unlisten = await subscription

    await resizePty('resize-id', 120, 40, 'profile-a')

    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
    )
    expect(transport.webApiFetch).not.toHaveBeenCalled()
    unlisten()
  })

  it('requests a replacement snapshot after reconnect and reports a missing session', async () => {
    vi.useFakeTimers()
    const reasons: string[] = []
    const subscription = listenPtyResync(
      'reconnect-id',
      (reason) => reasons.push(reason),
      'profile-a',
    )
    const firstSocket = await flushSocketCreation()
    firstSocket.open()
    const unlisten = await subscription
    expect(reasons).toEqual(['initial'])

    firstSocket.close()
    await vi.advanceTimersByTimeAsync(250)
    const secondSocket = await flushSocketCreation()
    secondSocket.open()
    expect(reasons).toEqual(['initial', 'reconnect'])

    secondSocket.message({ type: 'missing' })
    expect(reasons).toEqual(['initial', 'reconnect', 'missing'])
    unlisten()
  })
})
