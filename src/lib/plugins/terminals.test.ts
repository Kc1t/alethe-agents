import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writePty: vi.fn(async () => {}),
  recordAgentInput: vi.fn(),
  recordAgentActivityInput: vi.fn(),
  dataHandlers: new Map<string, (chunk: string) => void>(),
  exitHandlers: new Map<string, (payload: { code: number | null; reason: string }) => void>(),
  unlisten: vi.fn(),
  storeListeners: new Set<() => void>(),
  runtimes: {} as Record<string, { status: string; alive: boolean }>,
  projects: [] as unknown[],
}))

vi.mock('../tauri', () => ({
  writePty: mocks.writePty,
  lastPtySize: (ptyId: string) => (ptyId === 'pty-1' ? { cols: 120, rows: 40 } : null),
  listenPtyData: async (ptyId: string, handler: (chunk: string) => void) => {
    mocks.dataHandlers.set(ptyId, handler)
    return mocks.unlisten
  },
  listenPtyExit: async (
    ptyId: string,
    handler: (payload: { code: number | null; reason: string }) => void,
  ) => {
    mocks.exitHandlers.set(ptyId, handler)
    return mocks.unlisten
  },
}))
vi.mock('../agentCompletionMonitor', () => ({ recordAgentInput: mocks.recordAgentInput }))
vi.mock('../activityTracker', () => ({ recordAgentActivityInput: mocks.recordAgentActivityInput }))
vi.mock('../agentProviders', () => ({ agentLabel: (agent: string) => `label:${agent}` }))

const subscribe = (listener: () => void) => {
  mocks.storeListeners.add(listener)
  return () => mocks.storeListeners.delete(listener)
}
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => ({ projects: mocks.projects }), subscribe },
  getProjectDefaultCwd: () => '',
  selectActiveProject: () => null,
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ byPtyId: mocks.runtimes }), subscribe },
}))
vi.mock('../../stores/uiStore', () => ({ useUiStore: { getState: () => ({}) } }))

const { createPluginTerminals } = await import('./terminals')
import type { Disposable } from './types'

function seed() {
  mocks.projects = [
    {
      id: 'p1',
      name: 'Portfolio',
      archived: false,
      terminals: [
        {
          id: 't1',
          name: 'Builder',
          activeTabId: 'a',
          tabs: [
            { id: 'a', type: 'claude', ptyId: 'pty-1' },
            { id: 'b', type: 'shell', ptyId: 'pty-2' },
            { id: 'c', type: 'codex', ptyId: null },
          ],
        },
        {
          id: 'w1',
          name: 'Docs',
          kind: 'browser',
          tabs: [{ id: 'x', type: 'shell', ptyId: 'pty-9' }],
        },
      ],
    },
    {
      id: 'p2',
      name: 'Old',
      archived: true,
      terminals: [{ id: 't9', name: 'Gone', tabs: [{ id: 'z', type: 'claude', ptyId: 'pty-8' }] }],
    },
  ]
  mocks.runtimes = {
    'pty-1': { status: 'working', alive: true },
    'pty-2': { status: 'waiting', alive: true },
    'pty-8': { status: 'working', alive: true },
    'pty-9': { status: 'working', alive: true },
  }
}

function notify() {
  for (const listener of mocks.storeListeners) listener()
}

const allowAll = () => undefined

describe('plugin terminals', () => {
  let subscriptions: Disposable[]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.dataHandlers.clear()
    mocks.exitHandlers.clear()
    mocks.storeListeners.clear()
    subscriptions = []
    seed()
  })

  it('lists every running tab of plain terminals in live projects, without PTY ids', () => {
    const sessions = createPluginTerminals(allowAll, subscriptions).sessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({
      terminalId: 't1',
      projectId: 'p1',
      name: 'Builder',
      agent: 'claude',
      agentLabel: 'label:claude',
      shell: false,
      status: 'working',
    })
    expect(sessions[1]).toMatchObject({ agent: 'shell', shell: true, status: 'waiting' })
    expect(JSON.stringify(sessions)).not.toContain('pty-')
  })

  it('keeps a session id for the life of its process and issues a new one for a new process', () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const first = terminals.sessions()[0].id
    expect(terminals.sessions()[0].id).toBe(first)
    ;(
      mocks.projects[0] as { terminals: { tabs: { ptyId: string | null }[] }[] }
    ).terminals[0].tabs[0].ptyId = 'pty-3'
    mocks.runtimes['pty-3'] = { status: 'waiting', alive: true }
    expect(terminals.sessions()[0].id).not.toBe(first)
  })

  it('drops a session whose process is no longer alive', () => {
    mocks.runtimes['pty-2'] = { status: 'stopped', alive: false }
    expect(createPluginTerminals(allowAll, subscriptions).sessions()).toHaveLength(1)
  })

  it('requires terminal.read to read and terminal.write to type', async () => {
    const granted: string[] = []
    const terminals = createPluginTerminals((capability) => {
      granted.push(capability)
      if (capability === 'terminal.write') throw new Error('capability_denied')
    }, subscriptions)
    const [session] = terminals.sessions()
    terminals.size(session.id)
    await expect(terminals.write(session.id, 'hi')).rejects.toThrow('capability_denied')
    expect(granted).toEqual(['terminal.read', 'terminal.read', 'terminal.write'])
    expect(mocks.writePty).not.toHaveBeenCalled()
  })

  it('types into the session and counts it as input the agent received', async () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const [session] = terminals.sessions()
    await terminals.write(session.id, 'run the tests')
    await terminals.write(session.id, '\r')
    expect(mocks.writePty).toHaveBeenNthCalledWith(1, 'pty-1', 'run the tests')
    expect(mocks.recordAgentInput).toHaveBeenNthCalledWith(2, 'pty-1', '\r')
    expect(mocks.recordAgentActivityInput).toHaveBeenNthCalledWith(1, 'pty-1', 'run the tests')
  })

  it('refuses an id it never issued', () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    expect(() => terminals.onOutput('session-x', () => undefined)).toThrow('unknown_session')
  })

  it('reports the size last sent to the process', () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const [claude, shell] = terminals.sessions()
    expect(terminals.size(claude.id)).toEqual({ cols: 120, rows: 40 })
    expect(terminals.size(shell.id)).toBeNull()
  })

  it('fires onChange only when a session or its status changes', () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const handler = vi.fn()
    const subscription = terminals.onChange(handler)
    notify()
    expect(handler).not.toHaveBeenCalled()
    mocks.runtimes['pty-1'] = { status: 'waiting', alive: true }
    notify()
    expect(handler).toHaveBeenCalledTimes(1)
    subscription.dispose()
    mocks.runtimes['pty-1'] = { status: 'working', alive: true }
    notify()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('streams output and exit, and stops once disposed', async () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const [session] = terminals.sessions()
    const chunks: string[] = []
    const exits: unknown[] = []
    const output = terminals.onOutput(session.id, (chunk) => chunks.push(chunk))
    terminals.onExit(session.id, (exit) => exits.push(exit))
    await Promise.resolve()
    mocks.dataHandlers.get('pty-1')?.('hello')
    mocks.exitHandlers.get('pty-1')?.({ code: 0, reason: 'exited' })
    output.dispose()
    mocks.dataHandlers.get('pty-1')?.('ignored')
    expect(chunks).toEqual(['hello'])
    expect(exits).toEqual([{ code: 0, reason: 'exited' }])
    expect(mocks.unlisten).toHaveBeenCalledTimes(1)
  })

  it('tracks each subscription for deactivation and forgets it once disposed', () => {
    const terminals = createPluginTerminals(allowAll, subscriptions)
    const [session] = terminals.sessions()
    const output = terminals.onOutput(session.id, () => undefined)
    const change = terminals.onChange(() => undefined)
    expect(subscriptions).toHaveLength(2)
    output.dispose()
    expect(subscriptions).toEqual([change])
  })
})
