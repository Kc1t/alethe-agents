import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  agentHooksSettingsPath: vi.fn(async () => '/tmp/hooks.json'),
  aiMemoryCodexConfigWrite: vi.fn(async () => undefined),
  aiMemoryDetect: vi.fn(async () => ({ installed: false })),
  aiMemoryMcpConfigPath: vi.fn(async () => '/tmp/memory-mcp.json'),
  aiMemoryOpenCodeConfigWrite: vi.fn(async () => undefined),
  codexHooksConfigWrite: vi.fn(async () => undefined),
  codexMcpConfigWrite: vi.fn(async () => undefined),
  graphifyCodexConfigWrite: vi.fn(async () => undefined),
  graphifyEnsureGraph: vi.fn(async () => undefined),
  graphifyMcpConfigPath: vi.fn(async () => '/tmp/graphify-mcp.json'),
  graphifyOpenCodeConfigWrite: vi.fn(async () => undefined),
  gsdOpenCodePluginWrite: vi.fn(async () => undefined),
  orchestratorMcpConfigPath: vi.fn(async () => '/tmp/orchestrator-mcp.json'),
  playwrightMcpConfigPath: vi.fn(async () => '/tmp/playwright-mcp.json'),
}))

const ui = vi.hoisted(() => ({ pushToast: vi.fn() }))

const store = vi.hoisted(() => ({
  state: {
    projects: [] as unknown[],
    cliPaths: {} as Record<string, string>,
    preferences: {
      enabledFeatures: { orchestrator: false, aiMemory: false, playwright: false, gsdSync: false },
      router9: { enabled: false, apiKey: '', port: 0 },
      playwrightBrowserMode: 'shared',
      playwrightDedicatedHeadless: false,
      gsdSyncModelChain: [] as string[],
      agentDefaults: undefined as unknown,
    },
  },
}))

vi.mock('./tauri', () => tauri)
vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: { getState: () => store.state },
}))
vi.mock('../stores/uiStore', () => ({
  useUiStore: { getState: () => ui },
}))

import { launchContextForPty, launcherOverrideFor, prepareAgentLaunch } from './agentLaunchPlan'

beforeEach(() => {
  vi.clearAllMocks()
  store.state.projects = []
  store.state.cliPaths = {}
  store.state.preferences.agentDefaults = undefined
  store.state.preferences.enabledFeatures = {
    orchestrator: false,
    aiMemory: false,
    playwright: false,
    gsdSync: false,
  }
})

describe('prepareAgentLaunch', () => {
  it('keeps a resumed Claude planner wired to the orchestrator and its own pty id', async () => {
    store.state.preferences.enabledFeatures.orchestrator = true

    const launch = await prepareAgentLaunch({
      agent: 'claude',
      ptyId: 'pty-1',
      cwd: '/repo',
      extraArgs: ['--dangerously-skip-permissions'],
      resumeId: 'session-1',
    })

    expect(launch?.args).toEqual([
      '--resume',
      'session-1',
      '--mcp-config',
      '/tmp/orchestrator-mcp.json',
      '--settings',
      '/tmp/hooks.json',
      '--dangerously-skip-permissions',
    ])
    expect(launch?.env.ALETHE_PLANNER).toBe('pty-1')
    expect(tauri.orchestratorMcpConfigPath).toHaveBeenCalledWith(
      'pty-1',
      'pty-1',
      'claude',
      '/repo',
    )
  })

  it('hands every managed MCP server to Claude, not only the orchestrator', async () => {
    store.state.preferences.enabledFeatures.playwright = true

    const launch = await prepareAgentLaunch({
      agent: 'claude',
      ptyId: 'pty-1',
      cwd: '/repo',
      graphifyRepo: '/repo',
      resumeId: 'session-1',
    })

    expect(launch?.args).toEqual([
      '--resume',
      'session-1',
      '--mcp-config',
      '/tmp/graphify-mcp.json',
      '--mcp-config',
      '/tmp/playwright-mcp.json',
      '--settings',
      '/tmp/hooks.json',
    ])
  })

  it('registers a Codex planner through its in-repo config instead of a flag', async () => {
    store.state.preferences.enabledFeatures.orchestrator = true

    const launch = await prepareAgentLaunch({
      agent: 'codex',
      ptyId: 'pty-2',
      cwd: '/repo',
      resumeId: 'thread-1',
    })

    expect(launch?.args).toEqual(['resume', 'thread-1'])
    expect(tauri.codexHooksConfigWrite).toHaveBeenCalledWith('/repo', 'pty-2')
    expect(tauri.codexMcpConfigWrite).toHaveBeenCalledWith('/repo', 'pty-2', 'pty-2', 'codex')
    expect(launch?.env.ALETHE_PLANNER).toBe('pty-2')
  })

  it('reports a Codex planner config that could not be written', async () => {
    store.state.preferences.enabledFeatures.orchestrator = true
    tauri.codexMcpConfigWrite.mockRejectedValueOnce(new Error('mkdir_failed:Permission denied'))

    await prepareAgentLaunch({ agent: 'codex', ptyId: 'pty-2', cwd: '/read-only' })

    expect(ui.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Planner tools could not be installed',
        body: expect.stringContaining('/read-only: mkdir_failed:Permission denied'),
      }),
    )
  })

  it('launches a planner tab with the planner model, and an ordinary tab with the provider one', async () => {
    store.state.preferences.agentDefaults = {
      providers: { claude: { model: 'sonnet', effort: 'medium' } },
      planner: { claude: { model: 'opus' } },
      worker: {},
    }
    store.state.projects = [
      {
        terminals: [
          // Never spawned: no pty id yet, so the launch runs under the tab's own id.
          { name: 'Lead', tabs: [{ id: 'tab-lead', ptyId: null, orchestrationRole: 'planner' }] },
          { name: 'Side', tabs: [{ id: 'tab-side', ptyId: 'pty-side' }] },
        ],
      },
    ]

    const planner = await prepareAgentLaunch({ agent: 'claude', ptyId: 'tab-lead', resumeId: 's1' })
    const ordinary = await prepareAgentLaunch({
      agent: 'claude',
      ptyId: 'pty-side',
      resumeId: 's2',
    })

    expect(planner?.args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'medium'])
    expect(ordinary?.args.slice(-4)).toEqual(['--model', 'sonnet', '--effort', 'medium'])
  })

  it('stops as soon as the caller is cancelled', async () => {
    store.state.preferences.enabledFeatures.orchestrator = true

    const launch = await prepareAgentLaunch({
      agent: 'claude',
      ptyId: 'pty-1',
      cwd: '/repo',
      graphifyRepo: '/repo',
      isCancelled: () => true,
    })

    expect(launch).toBeNull()
    expect(tauri.orchestratorMcpConfigPath).not.toHaveBeenCalled()
  })

  it('still tags a plain shell with its pty id', async () => {
    const launch = await prepareAgentLaunch({ ptyId: 'pty-3', extraArgs: ['-l'] })

    expect(launch).toEqual({
      args: ['-l'],
      sessionId: undefined,
      createdSession: false,
      env: { ALETHE_PLANNER: 'pty-3' },
    })
  })
})

describe('launchContextForPty', () => {
  it('reads the project-level inputs from the pane that owns the pty', () => {
    store.state.projects = [
      {
        graphifyEnabled: true,
        gsdWatcherEnabled: true,
        terminals: [
          { name: 'Lead', cwd: '/repo', tabs: [{ ptyId: 'pty-1', useRouter9: true }] },
          { name: 'Other', cwd: '/elsewhere', tabs: [{ ptyId: 'pty-9' }] },
        ],
      },
    ]

    expect(launchContextForPty('pty-1')).toEqual({
      useRouter9: true,
      graphifyRepo: '/repo',
      gsdWatcherEnabled: true,
    })
  })

  it('returns nothing for a pty no pane owns', () => {
    expect(launchContextForPty('missing')).toEqual({})
  })
})

describe('launcherOverrideFor', () => {
  it('uses the configured path only while it still points at that agent', () => {
    store.state.cliPaths = { claude: '/opt/bin/claude', codex: '/opt/bin/not-codex' }

    expect(launcherOverrideFor('claude')).toBe('/opt/bin/claude')
    expect(launcherOverrideFor('codex')).toBeUndefined()
    expect(launcherOverrideFor('opencode')).toBeUndefined()
  })
})
