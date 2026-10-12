import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../../../lib/tauri', () => ({
  attachPty: vi.fn(async () => ''),
  killPty: vi.fn(async () => {}),
  listenPtyExit: vi.fn(async () => () => {}),
  spawnPty: vi.fn(async () => ({ id: 'pty-worker' })),
}))

import { spawnPty } from '../../../lib/tauri'
import { EMPTY_PROJECTS_FILE } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useAgentWorkers } from './useAgentWorkers'

function leadPaneWithRenderer(claudeFullscreen: boolean) {
  const file = structuredClone(EMPTY_PROJECTS_FILE)
  useProjectsStore.setState({
    ...file,
    preferences: { ...file.preferences, claudeFullscreen },
  } as never)
  return { current: { folder: 'D:/repo', ptyId: 'pty-lead' } }
}

function workerSpawnEnv() {
  return vi.mocked(spawnPty).mock.calls[0]?.[0].env
}

describe('agent canvas workers', () => {
  beforeEach(() => vi.clearAllMocks())

  // Upstream #322 made Claude Code's fullscreen renderer a preference; the canvas spawns its
  // workers outside the launch path that applies it, and must not bring fullscreen back.
  it('spawns a canvas worker in the classic renderer while fullscreen is off', async () => {
    const session = leadPaneWithRenderer(false)
    const { result } = renderHook(() => useAgentWorkers(session))

    result.current.spawnAgentWorker('claude', 'Worker')

    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(1))
    expect(workerSpawnEnv()).toMatchObject({ CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' })
  })

  it('leaves the renderer to Claude Code while fullscreen is on', async () => {
    const session = leadPaneWithRenderer(true)
    const { result } = renderHook(() => useAgentWorkers(session))

    result.current.spawnAgentWorker('claude', 'Worker')

    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(1))
    expect(workerSpawnEnv()?.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('leaves the renderer alone for a worker that is not Claude', async () => {
    const session = leadPaneWithRenderer(false)
    const { result } = renderHook(() => useAgentWorkers(session))

    result.current.spawnAgentWorker('cursor', 'Worker')

    await waitFor(() => expect(spawnPty).toHaveBeenCalledTimes(1))
    expect(workerSpawnEnv()).toBeUndefined()
  })
})
