import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../lib/tauri', () => ({
  agentHooksEndpoint: vi.fn(async () => 'http://127.0.0.1:1/hooks'),
  agentHooksSettingsPath: vi.fn(async () => 'hooks.json'),
  agentHooksToken: vi.fn(async () => 'token'),
  codexAppServerSend: vi.fn(async () => {}),
  codexAppServerStart: vi.fn(async () => ({})),
  codexAppServerStop: vi.fn(async () => {}),
  killPty: vi.fn(async () => {}),
  listenCodexAppServer: vi.fn(async () => () => {}),
  listenPtyData: vi.fn(async () => () => {}),
  listenPtyExit: vi.fn(async () => () => {}),
  spawnPty: vi.fn(async () => ({ id: 'pty-sandbox' })),
  writePty: vi.fn(async () => {}),
}))

import { spawnPty } from '../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useAgentSandboxStore } from './agentSandboxStore'
import { useProjectsStore } from './projectsStore'

/** The sandbox reads the renderer preference at launch, like every other pane launch. */
function demoWithRenderer(claudeFullscreen: boolean) {
  const file = structuredClone(EMPTY_PROJECTS_FILE)
  useProjectsStore.setState({
    ...file,
    preferences: { ...file.preferences, claudeFullscreen },
  } as never)
}

describe('agent sandbox launch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAgentSandboxStore.getState().stop()
  })

  // Upstream #322 made Claude Code's fullscreen renderer a preference; the sandbox spawns its
  // workers outside the launch path that applies it, and must not bring fullscreen back.
  it('spawns sandbox workers in the classic renderer while fullscreen is off', async () => {
    demoWithRenderer(false)

    await useAgentSandboxStore.getState().startDemo('D:/repo')

    const envs = vi
      .mocked(spawnPty)
      .mock.calls.filter(([args]) => args.command === 'claude')
      .map(([args]) => args.env)
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env).toMatchObject({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' })
    }
  })

  it('leaves the renderer to Claude Code while fullscreen is on', async () => {
    demoWithRenderer(true)

    await useAgentSandboxStore.getState().startDemo('D:/repo')

    const envs = vi
      .mocked(spawnPty)
      .mock.calls.filter(([args]) => args.command === 'claude')
      .map(([args]) => args.env)
    expect(envs.length).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
    }
  })
})
