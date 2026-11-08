import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Disposable, PluginAgents } from './types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  listen: vi.fn(),
  log: vi.fn(),
  locate: vi.fn(() => ({
    tab: { type: 'claude', cwd: '/tab', sessionId: 'conversation' },
    terminal: { cwd: '/pane' },
  })),
}))
vi.mock('../tauri', () => ({ pluginInvoke: mocks.invoke, pluginListen: mocks.listen }))
vi.mock('../auditLogger', () => ({ auditLogger: { log: mocks.log } }))
vi.mock('./presentation', () => ({
  pluginAgents: { label: (id: string) => id, accent: () => 'var(--accent)' },
}))
vi.mock('./terminals', () => ({
  locateSession: mocks.locate,
  liveSessionIdOf: (id: string) => (id === 'pty-1' ? 'session-1' : null),
}))
const { createPluginAgents } = await import('./agents')

const gatedCalls: [string, (api: PluginAgents) => unknown][] = [
  ['agent.observe', (api) => api.onHook(() => {})],
  ['agent.observe', (api) => api.transcript('session-1')],
  ['agent.approve', (api) => api.decidePermission('request-1', 'allow')],
  ['agent.approve', (api) => api.onPermissionReleased(() => {})],
]

describe('plugin agents', () => {
  let subscriptions: Disposable[]
  beforeEach(() => {
    vi.clearAllMocks()
    subscriptions = []
    mocks.listen.mockResolvedValue(vi.fn())
  })

  it.each(gatedCalls)(
    'requires %s before looking up sessions, listening, or invoking (%#)',
    async (cap, call) => {
      const require = vi.fn(() => {
        throw new Error('denied')
      })
      await expect(
        Promise.resolve().then(() => call(createPluginAgents(require, subscriptions))),
      ).rejects.toThrow('denied')
      expect(require).toHaveBeenCalledExactlyOnceWith(cap)
      expect(mocks.invoke).not.toHaveBeenCalled()
      expect(mocks.listen).not.toHaveBeenCalled()
      expect(mocks.locate).not.toHaveBeenCalled()
      expect(subscriptions).toEqual([])
    },
  )

  it('relays hooks keyed by an opaque session id and drops hooks from unknown processes', async () => {
    const handler = vi.fn()
    const stop = vi.fn()
    mocks.listen.mockResolvedValueOnce(stop)
    const api = createPluginAgents(() => {}, subscriptions)
    const disposable = api.onHook(handler)
    await Promise.resolve()
    const [event, dispatch] = mocks.listen.mock.calls[0]
    expect(event).toBe('agent-hook')
    dispatch({
      plannerId: 'pty-1',
      hook_event_name: 'PermissionRequest',
      permissionRequestId: 'request-1',
      tool_name: 'Bash',
      session_id: 'conversation',
    })
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      hook_event_name: 'PermissionRequest',
      permissionRequestId: 'request-1',
      tool_name: 'Bash',
      session_id: 'conversation',
    })
    expect(JSON.stringify(handler.mock.calls)).not.toContain('pty-1')
    dispatch({ plannerId: 'gone', hook_event_name: 'Stop' })
    dispatch({ plannerId: 'pty-1' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(subscriptions).toContain(disposable)
    disposable.dispose()
    dispatch({ plannerId: 'pty-1', hook_event_name: 'Stop' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledOnce()
    expect(subscriptions).toEqual([])
  })

  it('reads the host transcript snapshot and forwards its revision cursor', async () => {
    const api = createPluginAgents(() => {}, subscriptions)
    const messages = [{ role: 'assistant', text: 'Done', tool: { name: 'Edit', path: 'app.ts' } }]
    mocks.invoke.mockResolvedValueOnce({
      sessionId: 'conversation',
      revision: 42,
      unchanged: false,
      firstIndex: 5,
      messages,
    })
    expect(await api.transcript('session-1')).toEqual({
      conversationId: 'conversation',
      revision: 42,
      unchanged: false,
      firstIndex: 5,
      messages,
    })
    expect(mocks.invoke).toHaveBeenLastCalledWith('agent_transcript_snapshot', {
      provider: 'claude',
      cwd: '/tab',
      sessionId: 'conversation',
      since: null,
    })
    mocks.invoke.mockResolvedValueOnce({
      sessionId: 'conversation',
      revision: 42,
      unchanged: true,
      firstIndex: 0,
      messages: [],
    })
    expect(await api.transcript('session-1', 42)).toMatchObject({ unchanged: true, messages: [] })
    expect(mocks.invoke).toHaveBeenLastCalledWith(
      'agent_transcript_snapshot',
      expect.objectContaining({ since: 42 }),
    )
    mocks.invoke.mockRejectedValueOnce(new Error('snapshot failed'))
    await expect(api.transcript('session-1')).rejects.toThrow('snapshot failed')
    mocks.locate.mockReturnValueOnce({
      tab: { type: 'opencode', cwd: '/tab', sessionId: 'conversation' },
      terminal: { cwd: '/pane' },
    })
    await expect(api.transcript('session-1')).rejects.toThrow('transcript_unsupported:opencode')
  })

  it('maps permission decisions and release events to the registered backend contract', async () => {
    const api = createPluginAgents(() => {}, subscriptions)
    for (const behavior of ['allow', 'deny', 'defer'] as const) {
      await api.decidePermission('request-1', behavior, 'reason')
      expect(mocks.invoke).toHaveBeenLastCalledWith('agent_permission_decide', {
        requestId: 'request-1',
        behavior,
        message: 'reason',
      })
    }
    mocks.invoke.mockRejectedValueOnce(new Error('no pending permission'))
    await expect(api.decidePermission('expired', 'allow')).rejects.toThrow('no pending permission')
    const handler = vi.fn()
    const off = api.onPermissionReleased(handler)
    await Promise.resolve()
    const [event, dispatch] = mocks.listen.mock.calls[0]
    expect(event).toBe('agent-permission://released')
    dispatch({ requestId: 'request-1', reason: 'untargeted' })
    expect(handler).toHaveBeenCalledWith({ requestId: 'request-1', reason: 'untargeted' })
    off.dispose()
    dispatch({ requestId: 'request-1', reason: 'expired' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('unlistens a late subscription after disposal and logs subscription errors', async () => {
    let resolve!: (stop: () => void) => void
    mocks.listen.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const api = createPluginAgents(() => {}, subscriptions)
    const off = api.onHook(() => {})
    off.dispose()
    const stop = vi.fn()
    resolve(stop)
    await Promise.resolve()
    expect(stop).toHaveBeenCalledOnce()
    mocks.listen.mockRejectedValueOnce(new Error('offline'))
    api.onHook(() => {})
    await Promise.resolve()
    expect(subscriptions).toEqual([])
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }))
  })
})
