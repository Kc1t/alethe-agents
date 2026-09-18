import { beforeEach, describe, expect, it, vi } from 'vitest'

const agentHooksSettingsPath = vi.fn(async () => 'hooks.json')
const orchestratorMcpConfigPath = vi.fn(async () => 'orchestrator-mcp.json')
const restartPty = vi.fn(async (args: unknown) => ({ id: (args as { id: string }).id }))

vi.mock('./tauri', () => ({
  agentHooksSettingsPath: (...args: unknown[]) => agentHooksSettingsPath(...args),
  orchestratorMcpConfigPath: (...args: unknown[]) => orchestratorMcpConfigPath(...args),
  restartPty: (...args: unknown[]) => restartPty(...args),
}))

let orchestratorEnabled = true
const setSubTabSessionId = vi.fn()

vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      preferences: { enabledFeatures: { orchestrator: orchestratorEnabled } },
      projects: [],
      setSubTabSessionId,
    }),
  },
}))

// Mocks must be registered before the module under test is loaded, since it reads the mocked
// stores/tauri bindings at call time rather than through injected parameters.
const { resumeSessionInPane } = await import('./paneResume')

const baseParams = {
  projectId: 'proj-1',
  terminalId: 'term-1',
  tabId: 'tab-1',
  ptyId: 'pty-1',
  sessionId: 'session-1',
  cwd: 'C:\\proj',
} as const

beforeEach(() => {
  agentHooksSettingsPath.mockClear()
  orchestratorMcpConfigPath.mockClear()
  restartPty.mockClear()
  setSubTabSessionId.mockClear()
  orchestratorEnabled = true
})

describe('resumeSessionInPane', () => {
  it('fetches the orchestrator mcp config for a resumed claude session and passes it to the launch', async () => {
    await resumeSessionInPane({ ...baseParams, agent: 'claude' })

    expect(orchestratorMcpConfigPath).toHaveBeenCalledWith('pty-1', expect.any(String), 'claude')
    expect(restartPty).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: expect.arrayContaining(['--mcp-config', 'orchestrator-mcp.json']),
      }),
    )
  })

  it('skips the orchestrator mcp config when the feature is disabled', async () => {
    orchestratorEnabled = false

    await resumeSessionInPane({ ...baseParams, agent: 'claude' })

    expect(orchestratorMcpConfigPath).not.toHaveBeenCalled()
    const call = restartPty.mock.calls[0]?.[0] as { extraArgs?: string[] }
    expect(call.extraArgs ?? []).not.toContain('--mcp-config')
  })

  it('never fetches an orchestrator mcp config for a non-claude agent', async () => {
    await resumeSessionInPane({ ...baseParams, agent: 'codex' })

    expect(orchestratorMcpConfigPath).not.toHaveBeenCalled()
  })

  it('stays non-fatal when fetching the orchestrator mcp config fails, like the normal spawn path', async () => {
    orchestratorMcpConfigPath.mockRejectedValueOnce(new Error('no mcp config for you'))

    await expect(resumeSessionInPane({ ...baseParams, agent: 'claude' })).resolves.toBeUndefined()
    expect(restartPty).toHaveBeenCalled()
  })
})
