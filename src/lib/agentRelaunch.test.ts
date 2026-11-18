import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProjectsStore } from '../stores/projectsStore'
import { relaunchAgentPty } from './agentRelaunch'
import { hasOrchestratorTools, recordClaudeLaunch } from './claudeMcpConfigs'
import {
  antigravityHooksConfigWrite,
  antigravityMcpConfigWrite,
  codexMcpConfigWrite,
  restartPty,
} from './tauri'

vi.mock('./tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tauri')>()),
  agentHooksSettingsPath: vi.fn(async () => 'C:\\Temp\\hooks.json'),
  restartPty: vi.fn(async ({ id }: { id: string }) => ({ id })),
  orchestratorMcpConfigPath: vi.fn(async () => 'C:\\Temp\\orchestrator-mcp.json'),
  playwrightMcpConfigPath: vi.fn(async () => 'C:\\Temp\\playwright-mcp.json'),
  antigravityHooksConfigWrite: vi.fn(async () => undefined),
  antigravityMcpConfigWrite: vi.fn(async () => undefined),
  codexMcpConfigWrite: vi.fn(async () => undefined),
  aiMemoryDetect: vi.fn(async () => ({ installed: false })),
}))

beforeEach(() => {
  vi.mocked(restartPty).mockClear()
  recordClaudeLaunch('pty-1', false)
  const { preferences } = useProjectsStore.getState()
  useProjectsStore.setState({
    preferences: {
      ...preferences,
      enabledFeatures: { ...preferences.enabledFeatures, orchestrator: true },
    },
  })
})

// Every relaunch of a Claude pane keeps its MCP servers and hooks, and only a launch that went
// through counts as the pane having the orchestrator tools (#248).
describe('relaunchAgentPty', () => {
  it('relaunches Claude with its MCP servers and hooks and records the tools', async () => {
    await relaunchAgentPty({ ptyId: 'pty-1', agent: 'claude', cwd: 'C:\\repo' })

    const args = vi.mocked(restartPty).mock.calls[0][0].extraArgs ?? []
    expect(args).toEqual(
      expect.arrayContaining(['--mcp-config', 'C:\\Temp\\orchestrator-mcp.json']),
    )
    expect(args).toEqual(expect.arrayContaining(['--settings', 'C:\\Temp\\hooks.json']))
    expect(hasOrchestratorTools('pty-1')).toBe(true)
  })

  it('hands a Claude inside WSL its MCP servers and hooks in guest form', async () => {
    await relaunchAgentPty({
      ptyId: 'pty-1',
      agent: 'claude',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    })

    const args = vi.mocked(restartPty).mock.calls[0][0].extraArgs ?? []
    expect(args).toEqual(
      expect.arrayContaining(['--mcp-config', '/mnt/c/Temp/orchestrator-mcp.json']),
    )
    expect(args).toEqual(expect.arrayContaining(['--settings', '/mnt/c/Temp/hooks.json']))
    expect(args.some((arg) => arg.includes('C:\\'))).toBe(false)
  })

  it('records nothing when the restart fails', async () => {
    vi.mocked(restartPty).mockRejectedValueOnce(new Error('spawn failed'))

    await expect(
      relaunchAgentPty({ ptyId: 'pty-1', agent: 'claude', cwd: 'C:\\repo' }),
    ).rejects.toThrow('spawn failed')

    expect(hasOrchestratorTools('pty-1')).toBe(false)
  })

  it('refreshes Antigravity workspace hooks and MCP config on relaunch when orchestration is on', async () => {
    await relaunchAgentPty({ ptyId: 'pty-agy', agent: 'antigravity', cwd: 'C:\\repo' })

    expect(antigravityHooksConfigWrite).toHaveBeenCalledWith('C:\\repo', 'pty-agy')
    expect(antigravityMcpConfigWrite).toHaveBeenCalledWith(
      'C:\\repo',
      'pty-agy',
      'Antigravity',
      'antigravity',
    )
    expect(codexMcpConfigWrite).not.toHaveBeenCalled()
  })
})
