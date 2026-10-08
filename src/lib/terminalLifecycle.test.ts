import { beforeEach, describe, expect, it, vi } from 'vitest'

const { killPtys, ghosttyKill } = vi.hoisted(() => ({
  killPtys: vi.fn(() => Promise.resolve([] as string[])),
  ghosttyKill: vi.fn(() => Promise.resolve()),
}))
vi.mock('./tauri', () => ({ killPtys, ghosttyKill }))
vi.mock('./sessionDiscovery', () => ({ releaseSessionClaim: vi.fn() }))
vi.mock('./sessionResume', () => ({ removeSession: vi.fn() }))
vi.mock('../stores/terminalsStore', () => ({
  useTerminalsStore: { getState: () => ({ unregister: vi.fn() }) },
}))

import { cleanupPtys } from './terminalLifecycle'

describe('cleanupPtys', () => {
  beforeEach(() => {
    killPtys.mockClear()
    ghosttyKill.mockClear()
  })

  it('kills the PTYs of ordinary terminals once each', () => {
    cleanupPtys(['a', 'b', 'a', null])
    expect(killPtys).toHaveBeenCalledWith(['a', 'b'])
  })

  it('only detaches from an orchestrator shell, which keeps running', () => {
    cleanupPtys(['orchestrator-shell-01', 'a'])
    expect(killPtys).toHaveBeenCalledWith(['a'])
    expect(ghosttyKill).not.toHaveBeenCalledWith('orchestrator-shell-01')
  })
})
