import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tauri', () => ({
  getPtyCwd: vi.fn(async () => 'D:/repo'),
  restartPty: vi.fn(async () => ({ id: 'pty-1' })),
  snapshotAntigravitySessions: vi.fn(async () => []),
  snapshotClaudeSessions: vi.fn(async () => [{ id: 'chat-1', modified_at_ms: 1 }]),
  snapshotCodexSessions: vi.fn(async () => []),
  snapshotOpenCodeSessions: vi.fn(async () => []),
}))
vi.mock('./claudeMcpConfigs', () => ({
  claudeLaunchExtras: vi.fn(async () => undefined),
  graphifyRepoOf: vi.fn(() => null),
  recordClaudeLaunch: vi.fn(),
}))
vi.mock('./spawnQueue', () => ({
  acquireSpawnSlot: vi.fn(async () => true),
  releaseSpawnSlot: vi.fn(),
}))

import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { resetLastSession } from './resetLastSession'
import { restartPty } from './tauri'
import { EMPTY_PROJECTS_FILE } from './types'

/** One live Claude pane, with the renderer preference the reset reads. */
function oneLiveClaudePane(claudeFullscreen: boolean) {
  const file = structuredClone(EMPTY_PROJECTS_FILE)
  useProjectsStore.setState({
    ...file,
    preferences: { ...file.preferences, claudeFullscreen },
    projects: [
      {
        id: 'p1',
        terminals: [
          { id: 't1', cwd: 'D:/repo', tabs: [{ id: 'tab-1', type: 'claude', ptyId: 'pty-1' }] },
        ],
      },
    ],
  } as never)
  useTerminalsStore.setState({ byPtyId: { 'pty-1': { alive: true } } } as never)
}

describe('resetLastSession', () => {
  beforeEach(() => vi.clearAllMocks())

  // Upstream #322 made Claude Code's fullscreen renderer a preference; a reset restarts the pane
  // outside the launch path that applies it, and must not bring fullscreen back.
  it('restarts a Claude pane in the classic renderer while fullscreen is off', async () => {
    oneLiveClaudePane(false)

    await resetLastSession()

    expect(vi.mocked(restartPty).mock.calls[0]?.[0].env).toMatchObject({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    })
  })

  it('leaves the renderer to Claude Code while fullscreen is on', async () => {
    oneLiveClaudePane(true)

    await resetLastSession()

    expect(restartPty).toHaveBeenCalledTimes(1)
    expect(vi.mocked(restartPty).mock.calls[0]?.[0].env?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe(
      undefined,
    )
  })
})
