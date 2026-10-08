import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve({ id: 'x' })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { restartPty } from './pty'

describe('restartPty', () => {
  beforeEach(() => invoke.mockClear())

  it('restarts a view of an orchestrator shell through the orchestrator', async () => {
    const restarted = await restartPty({
      id: 'orchestrator-shell-01',
      cols: 80,
      rows: 24,
    } as Parameters<typeof restartPty>[0])
    expect(invoke).toHaveBeenCalledWith('orchestrator_shell_restart', { shellId: 'shell-01' })
    expect(restarted).toEqual({ id: 'orchestrator-shell-01' })
  })

  it('restarts any other PTY as before', async () => {
    await restartPty({ id: 'abc', cols: 80, rows: 24 } as Parameters<typeof restartPty>[0])
    expect(invoke).toHaveBeenCalledWith('restart_pty', expect.objectContaining({ id: 'abc' }))
  })
})
