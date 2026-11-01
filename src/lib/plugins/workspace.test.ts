import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writePty: vi.fn(async () => {}),
  createAgentTerminal: vi.fn(async () => ({ id: 'new-terminal' })),
  deleteTerminal: vi.fn(),
  setActiveProjectOnly: vi.fn(),
  focusWorkspaceTerminal: vi.fn(),
  setActiveTerminal: vi.fn(),
  requestPaneFocus: vi.fn(),
  requestPaneFlash: vi.fn(),
}))

const project = {
  id: 'p1',
  name: 'Portfolio',
  archived: false,
  terminals: [
    {
      id: 't1',
      name: 'Claude Code',
      cwd: 'D:/repos/portfolio',
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', type: 'claude', cwd: 'D:/repos/portfolio', ptyId: 'pty-1' }],
    },
    {
      id: 't2',
      name: 'Shell',
      cwd: 'D:/repos/portfolio',
      activeTabId: 'tab-2',
      tabs: [{ id: 'tab-2', type: 'shell', cwd: 'D:/repos/portfolio', ptyId: null }],
    },
    { id: 'b1', name: 'Docs', kind: 'browser', cwd: '', activeTabId: 'x', tabs: [] },
  ],
}

const archived = { id: 'p2', name: 'Old', archived: true, terminals: [] }

vi.mock('../../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [project, archived],
      preferences: { enabledAgents: { claude: true, codex: false, shell: true } },
      createAgentTerminal: mocks.createAgentTerminal,
      deleteTerminal: mocks.deleteTerminal,
      setActiveProjectOnly: mocks.setActiveProjectOnly,
      focusWorkspaceTerminal: mocks.focusWorkspaceTerminal,
    }),
  },
  getProjectDefaultCwd: () => 'D:/repos/portfolio',
  selectActiveProject: () => project,
}))
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ byPtyId: { 'pty-1': { status: 'working' } } }) },
}))
vi.mock('../../stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({
      activeTerminal: { projectId: 'p1', terminalId: 't1' },
      setActiveTerminal: mocks.setActiveTerminal,
      requestPaneFocus: mocks.requestPaneFocus,
      requestPaneFlash: mocks.requestPaneFlash,
    }),
  },
}))
vi.mock('../agentProviders', () => ({
  agentLabel: (agent: string) => ({ claude: 'Claude Code', shell: 'Shell' })[agent] ?? agent,
}))
vi.mock('../tauri', () => ({ writePty: mocks.writePty }))
vi.mock('../types', () => ({ isShellAgentType: (agent: string) => agent === 'shell' }))

const { createPluginWorkspace } = await import('./workspace')

function workspaceWith(granted: string[]) {
  return createPluginWorkspace((capability) => {
    if (!granted.includes(capability)) throw new Error(`capability_denied:test:${capability}`)
  })
}

beforeEach(() => vi.clearAllMocks())

describe('plugin workspace', () => {
  it('lists live projects and plain terminals, without process ids', () => {
    const snapshot = workspaceWith(['workspace.read']).snapshot()

    expect(snapshot.projects).toEqual([{ id: 'p1', name: 'Portfolio', path: 'D:/repos/portfolio' }])
    expect(snapshot.terminals.map((terminal) => terminal.id)).toEqual(['t1', 't2'])
    expect(snapshot.terminals[0]).toMatchObject({
      agentLabel: 'Claude Code',
      running: true,
      busy: true,
    })
    expect(snapshot.terminals[1]).toMatchObject({ running: false, busy: false })
    expect(JSON.stringify(snapshot)).not.toContain('pty-1')
    expect(snapshot.agents).toEqual([{ id: 'claude', label: 'Claude Code' }])
    expect(snapshot).toMatchObject({ focusedProjectId: 'p1', focusedTerminalId: 't1' })
  })

  it('refuses every call the manifest did not ask for', async () => {
    const workspace = workspaceWith([])

    expect(() => workspace.snapshot()).toThrow('workspace.read')
    expect(() => workspace.focusTerminal('t1')).toThrow('workspace.control')
    expect(() => workspace.closeTerminal('t1')).toThrow('workspace.control')
    await expect(workspace.openAgentTerminal('p1', { agent: 'claude' })).rejects.toThrow(
      'workspace.control',
    )
    await expect(workspace.writeToTerminal('t1', 'ls')).rejects.toThrow('terminal.write')
    expect(mocks.writePty).not.toHaveBeenCalled()
  })

  it('types into the running tab of a terminal it can see', async () => {
    const workspace = workspaceWith(['terminal.write'])

    await workspace.writeToTerminal('t1', 'hello\r')
    expect(mocks.writePty).toHaveBeenCalledWith('pty-1', 'hello\r')

    await expect(workspace.writeToTerminal('t2', 'ls')).rejects.toThrow('terminal_not_running')
    await expect(workspace.writeToTerminal('b1', 'ls')).rejects.toThrow('unknown_terminal')
  })

  it('opens only agents that are enabled, in a live project', async () => {
    const workspace = workspaceWith(['workspace.control'])

    await expect(
      workspace.openAgentTerminal('p1', { agent: 'claude', prompt: 'fix the header' }),
    ).resolves.toBe('new-terminal')
    expect(mocks.createAgentTerminal).toHaveBeenCalledWith('p1', {
      name: 'Claude Code',
      cwd: 'D:/repos/portfolio',
      firstTab: { type: 'claude', cwd: 'D:/repos/portfolio', initialInput: 'fix the header' },
    })

    await expect(workspace.openAgentTerminal('p1', { agent: 'codex' })).rejects.toThrow(
      'agent_not_enabled',
    )
    await expect(workspace.openAgentTerminal('p2', { agent: 'claude' })).rejects.toThrow(
      'unknown_project',
    )
  })

  it('focuses and flashes a terminal, and closes one through the store', () => {
    const workspace = workspaceWith(['workspace.control'])

    workspace.focusTerminal('t1')
    expect(mocks.focusWorkspaceTerminal).toHaveBeenCalledWith('p1', 't1')
    expect(mocks.requestPaneFlash).toHaveBeenCalledWith('t1')

    workspace.closeTerminal('t1')
    expect(mocks.deleteTerminal).toHaveBeenCalledWith('p1', 't1')
  })
})
