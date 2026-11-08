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
  groups: [] as unknown[],
  ungroupedOrder: [] as string[],
  visible: new Set<string>(),
  restart: vi.fn(async () => {}),
  setActiveProjectOnly: vi.fn(),
  focusWorkspaceTerminal: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTerminal: vi.fn(),
  setActiveView: vi.fn(),
  requestPaneFocus: vi.fn(),
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

vi.mock('../agentTabRestart', () => ({ restartAgentTab: mocks.restart }))
vi.mock('../claudeMcpConfigs', () => ({ graphifyRepoOf: () => 'repo' }))
vi.mock('../ptyVisibility', () => ({
  computeVisibleFocusedPtyIds: () => ({ visible: mocks.visible }),
}))

const subscribe = (listener: () => void) => {
  mocks.storeListeners.add(listener)
  return () => mocks.storeListeners.delete(listener)
}
vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      projects: mocks.projects,
      groups: mocks.groups,
      ungroupedOrder: mocks.ungroupedOrder,
      setActiveProjectOnly: mocks.setActiveProjectOnly,
      focusWorkspaceTerminal: mocks.focusWorkspaceTerminal,
      setActiveTab: mocks.setActiveTab,
    }),
    subscribe,
  },
  getProjectDefaultCwd: () => '',
  selectActiveProject: () => null,
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ byPtyId: mocks.runtimes }), subscribe },
}))
vi.mock('../../stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({
      setActiveTerminal: mocks.setActiveTerminal,
      requestPaneFocus: mocks.requestPaneFocus,
      setActiveView: mocks.setActiveView,
    }),
    subscribe,
  },
}))

const { createPluginTerminals } = await import('./terminals')
import { registerAgentInput } from '../agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../agentPromptDelivery'
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
          cwd: '/repo',
          activeTabId: 'a',
          tabs: [
            { id: 'a', name: 'Main', type: 'claude', ptyId: 'pty-1', sessionId: 'conversation-1' },
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
    mocks.groups = []
    mocks.ungroupedOrder = []
    mocks.visible = new Set(['pty-1'])
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

describe('plugin terminal conversation operations', () => {
  const inputs = () => ({
    submit: vi.fn(async (_text: string) => {}),
    interrupt: vi.fn(async () => {}),
    readScreen: vi.fn(() => 'reply'),
  })
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    mocks.groups = []
    mocks.ungroupedOrder = []
    mocks.visible = new Set(['pty-1'])
  })

  it('includes target metadata and sidebar position without process identifiers', () => {
    const api = createPluginTerminals(allowAll, [])
    expect(api.sessions()[0]).toMatchObject({
      projectName: 'Portfolio',
      tabName: 'Main',
      cwd: '/repo',
      tabActive: true,
      visible: true,
      agentSessionId: 'conversation-1',
      disabled: false,
      order: 0,
    })
    expect(api.sessions()[1]).toMatchObject({ tabActive: false, visible: false, order: 1 })
    expect(JSON.stringify(api.sessions())).not.toContain('pty-')
  })

  it('notifies consumers when cwd or agent kind changes', () => {
    const api = createPluginTerminals(allowAll, [])
    const handler = vi.fn()
    const stop = api.onChange(handler)
    const project = mocks.projects[0] as { terminals: { cwd: string; tabs: { type: string }[] }[] }
    project.terminals[0].cwd = '/other'
    notify()
    expect(handler).toHaveBeenCalledTimes(1)
    project.terminals[0].tabs[0].type = 'codex'
    notify()
    expect(handler).toHaveBeenCalledTimes(2)
    stop.dispose()
  })

  it('submits through the mounted input and maps prompt and visibility refusals to typed errors', async () => {
    const api = createPluginTerminals(allowAll, [])
    const session = api.sessions()[0].id
    const input = inputs()
    const off = registerAgentInput('pty-1', input)
    try {
      await api.submit(session, 'hello')
      expect(input.submit).toHaveBeenCalledWith('hello')
      input.submit.mockRejectedValueOnce(new TerminalPromptOpenError())
      await expect(api.submit(session, 'hello')).rejects.toMatchObject({ code: 'prompt_open' })
      input.submit.mockRejectedValueOnce(new PaneHiddenError())
      await expect(api.submit(session, 'hello')).rejects.toMatchObject({ code: 'pane_hidden' })
      input.submit.mockRejectedValueOnce(new Error('write failed'))
      await expect(api.submit(session, 'hello')).rejects.toThrow('write failed')
    } finally {
      off()
    }
    await expect(api.submit(session, 'hello')).rejects.toMatchObject({ code: 'not_mounted' })
    await expect(api.submit('unknown', 'hello')).rejects.toMatchObject({ code: 'unknown_session' })
    mocks.runtimes['pty-1'].alive = false
    await expect(api.submit(session, 'hello')).rejects.toMatchObject({ code: 'unknown_session' })
  })

  it('rejects shell submission and disabled restarts and propagates restart failures', async () => {
    const api = createPluginTerminals(allowAll, [])
    const [agent, shell] = api.sessions()
    await expect(api.submit(shell.id, 'hello')).rejects.toMatchObject({ code: 'not_an_agent' })
    const project = mocks.projects[0] as { terminals: { disabled: boolean }[] }
    project.terminals[0].disabled = true
    await expect(api.restart(agent.id)).rejects.toMatchObject({ code: 'terminal_disabled' })
    project.terminals[0].disabled = false
    mocks.restart.mockRejectedValueOnce(new Error('restart failed'))
    await expect(api.restart(agent.id)).rejects.toThrow('restart failed')
  })

  it('interrupts with Escape and resumes through the same helper as the pane restart button', async () => {
    const api = createPluginTerminals(allowAll, [])
    const session = api.sessions()[0].id
    await api.interrupt(session)
    expect(mocks.writePty).toHaveBeenCalledWith('pty-1', '\x1b')
    await api.restart(session)
    expect(mocks.restart).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        terminalId: 't1',
        terminalCwd: '/repo',
        tab: expect.objectContaining({ sessionId: 'conversation-1' }),
        graphifyRepo: 'repo',
      }),
    )
  })

  it('reads only a bounded screen tail and rejects invalid line counts', () => {
    const api = createPluginTerminals(allowAll, [])
    const session = api.sessions()[0].id
    expect(api.readScreen(session, 30)).toBeNull()
    const input = inputs()
    const off = registerAgentInput('pty-1', input)
    try {
      expect(api.readScreen(session, 40)).toBe('reply')
      api.readScreen(session, 10000)
      expect(input.readScreen).toHaveBeenLastCalledWith(2000)
      for (const lines of [NaN, Infinity, -1, 0, 1.5])
        expect(() => api.readScreen(session, lines)).toThrow('invalid_screen_lines')
    } finally {
      off()
    }
  })

  it('focuses the chosen sub-tab and waits for its input to mount', async () => {
    const api = createPluginTerminals(allowAll, [])
    const session = api.sessions()[0].id
    const off = registerAgentInput('pty-1', inputs())
    try {
      await api.focus(session)
    } finally {
      off()
    }
    expect(mocks.setActiveProjectOnly).toHaveBeenCalledWith('p1')
    expect(mocks.setActiveTab).toHaveBeenCalledWith('p1', 't1', 'a')
    expect(mocks.focusWorkspaceTerminal).toHaveBeenCalledWith('p1', 't1')
    expect(mocks.setActiveView).toHaveBeenCalledWith('workspace')
    expect(mocks.requestPaneFocus).toHaveBeenCalledWith('t1')
  })

  it('requires each capability before looking up a session or causing side effects', async () => {
    const denied = vi.fn(() => {
      throw new Error('denied')
    })
    const api = createPluginTerminals(denied, [])
    for (const call of [
      () => api.submit('unknown', 'hello'),
      () => api.interrupt('unknown'),
      () => api.focus('unknown'),
    ]) {
      await expect(call()).rejects.toThrow('denied')
      expect(denied).toHaveBeenLastCalledWith('terminal.write')
    }
    expect(() => api.readScreen('unknown', 10)).toThrow('denied')
    expect(denied).toHaveBeenLastCalledWith('terminal.read')
    await expect(api.restart('unknown')).rejects.toThrow('denied')
    expect(denied).toHaveBeenLastCalledWith('terminal.restart')
  })
})

it('keeps sidebar project order followed by pane and tab order', () => {
  seed()
  mocks.groups = []
  mocks.ungroupedOrder = ['p3', 'p1']
  mocks.projects.push({
    id: 'p3',
    name: 'First',
    terminals: [
      {
        id: 't3',
        name: 'Worker',
        cwd: '/repo',
        activeTabId: 'third',
        tabs: [{ id: 'third', name: 'Agent', type: 'codex', ptyId: 'pty-3' }],
      },
    ],
  })
  mocks.runtimes['pty-3'] = { status: 'waiting', alive: true }
  const api = createPluginTerminals(allowAll, [])
  expect(api.sessions().map((s) => [s.projectId, s.order])).toEqual([
    ['p3', 0],
    ['p1', 1],
    ['p1', 2],
  ])
  const before = api.sessions().map((s) => s.id)
  mocks.runtimes['pty-3'].status = 'working'
  expect(api.sessions().map((s) => s.id)).toEqual(before)
})
