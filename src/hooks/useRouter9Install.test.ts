import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  attachPty: vi.fn(),
  killPty: vi.fn(),
  listenPtyData: vi.fn(),
  listenPtyExit: vi.fn(),
  router9InstallCommand: vi.fn(),
  router9Status: vi.fn(),
  router9Stop: vi.fn(),
  router9UninstallCommand: vi.fn(),
  ptyExists: vi.fn(),
  spawnPty: vi.fn(),
  writePty: vi.fn(),
}))

vi.mock('../lib/tauri', () => tauri)
vi.mock('../lib/agentProviders', () => ({ resolveAgentCliCommand: () => null }))

import { acquireAgentOperation, releaseAgentOperation } from './useAgentInstall'
import { useRouter9Install } from './useRouter9Install'

beforeEach(() => {
  tauri.router9InstallCommand.mockResolvedValue('npm install --prefix C:\\r9 9router@1.0.0')
  tauri.spawnPty.mockImplementation(async ({ id }: { id: string }) => ({ id }))
  tauri.listenPtyData.mockResolvedValue(() => undefined)
  tauri.listenPtyExit.mockResolvedValue(() => undefined)
  tauri.writePty.mockResolvedValue(undefined)
  tauri.killPty.mockResolvedValue(undefined)
  tauri.attachPty.mockResolvedValue('')
  tauri.ptyExists.mockResolvedValue(true)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useRouter9Install', () => {
  it('lets the shell run npm.ps1 under the Restricted policy of a fresh Windows', async () => {
    const { result, unmount } = renderHook(() => useRouter9Install())
    await act(() => result.current.run('install'))

    expect(tauri.spawnPty).toHaveBeenCalledWith(
      expect.objectContaining({ env: { PSExecutionPolicyPreference: 'RemoteSigned' } }),
    )
    unmount()
  })

  it('never runs npm when the run is cancelled while the shell is starting', async () => {
    let finishSpawn: () => void = () => undefined
    tauri.spawnPty.mockImplementation(
      ({ id }: { id: string }) =>
        new Promise((resolve) => {
          finishSpawn = () => resolve({ id })
        }),
    )
    const { result, unmount } = renderHook(() => useRouter9Install())

    let run: Promise<void> = Promise.resolve()
    act(() => {
      run = result.current.run('install')
    })
    await vi.waitFor(() => expect(tauri.spawnPty).toHaveBeenCalled())
    act(() => result.current.reset())
    await act(async () => {
      finishSpawn()
      await run
    })

    expect(tauri.writePty).not.toHaveBeenCalled()
    expect(tauri.killPty).toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
    expect(acquireAgentOperation('probe')).toBe(true)
    releaseAgentOperation('probe')
    unmount()
  })

  it.each(['listenPtyData', 'listenPtyExit'] as const)(
    'drops the %s listener that finishes registering after a cancel',
    async (listener) => {
      const stop = vi.fn()
      let finishListen: () => void = () => undefined
      tauri[listener].mockImplementation(
        () =>
          new Promise((resolve) => {
            finishListen = () => resolve(stop)
          }),
      )
      const { result, unmount } = renderHook(() => useRouter9Install())

      let run: Promise<void> = Promise.resolve()
      act(() => {
        run = result.current.run('install')
      })
      await vi.waitFor(() => expect(tauri[listener]).toHaveBeenCalled())
      act(() => result.current.reset())
      await act(async () => {
        finishListen()
        await run
      })

      expect(stop).toHaveBeenCalled()
      expect(tauri.writePty).not.toHaveBeenCalled()
      unmount()
    },
  )
})
