import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listenRemoteMessages: vi.fn(),
  flushProjectsState: vi.fn(),
  projectState: {} as Record<string, unknown>,
  pushToast: vi.fn(),
  setPreferences: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  setRemoteControlMaxDevices: vi.fn(),
  setRemoteControlReadOnly: vi.fn(),
  setRemoteControlSessionExpiry: vi.fn(),
  setRemoteControlShellInput: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  listenRemoteMessages: mocks.listenRemoteMessages,
  setRemoteControlEnabled: mocks.setRemoteControlEnabled,
  setRemoteControlMaxDevices: mocks.setRemoteControlMaxDevices,
  setRemoteControlReadOnly: mocks.setRemoteControlReadOnly,
  setRemoteControlSessionExpiry: mocks.setRemoteControlSessionExpiry,
  setRemoteControlShellInput: mocks.setRemoteControlShellInput,
}))

vi.mock('../stores/projectsStore', () => {
  const useProjectsStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector(mocks.projectState)
  useProjectsStore.getState = () => mocks.projectState
  return { flushProjectsState: mocks.flushProjectsState, useProjectsStore }
})

vi.mock('../stores/uiStore', () => {
  const useUiStore = (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ pushToast: mocks.pushToast })
  useUiStore.getState = () => ({ pushToast: mocks.pushToast })
  return { useUiStore }
})

import { useRemoteControlService } from './useRemoteControlService'

describe('useRemoteControlService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const preferences = {
      language: 'en',
      remoteAllowShellInput: false,
      remoteEnabled: true,
      remoteMaxDevices: 1,
      remoteReadOnly: true,
      remoteSessionExpirySecs: 3_600,
    }
    mocks.setPreferences.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(preferences, patch)
    })
    mocks.projectState = {
      hydrated: true,
      preferences,
      setPreferences: mocks.setPreferences,
    }
    mocks.listenRemoteMessages.mockResolvedValue(vi.fn())
    mocks.flushProjectsState.mockResolvedValue(undefined)
    mocks.setRemoteControlMaxDevices.mockResolvedValue({})
    mocks.setRemoteControlSessionExpiry.mockResolvedValue({})
    mocks.setRemoteControlReadOnly.mockResolvedValue({})
    mocks.setRemoteControlShellInput.mockResolvedValue({})
  })

  it('rolls back only remoteEnabled, reports enable failure, and does not retry', async () => {
    mocks.setRemoteControlEnabled.mockRejectedValueOnce(new Error('ports unavailable'))
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: false })

    const { rerender } = renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    })
    expect(mocks.pushToast).toHaveBeenCalledWith({
      title: 'Remote control could not start',
      body: expect.stringContaining('ports unavailable'),
    })
    expect(mocks.setRemoteControlEnabled).toHaveBeenCalledTimes(2)
    expect(mocks.setRemoteControlEnabled).toHaveBeenNthCalledWith(1, true, expect.any(Number))
    expect(mocks.setRemoteControlEnabled).toHaveBeenNthCalledWith(2, false, expect.any(Number))
    expect(mocks.flushProjectsState).toHaveBeenCalledTimes(1)

    rerender()
    await waitFor(() => {
      expect(mocks.setRemoteControlEnabled).toHaveBeenCalledWith(false, expect.any(Number))
    })
    rerender()

    expect(
      mocks.setRemoteControlEnabled.mock.calls.filter(([enabled]) => enabled === true),
    ).toHaveLength(1)
    expect(mocks.setPreferences).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a security setting cannot be applied', async () => {
    mocks.setRemoteControlReadOnly.mockRejectedValueOnce(new Error('read-only sync failed'))
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: false })

    renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    })
    expect(mocks.setRemoteControlEnabled).toHaveBeenCalledTimes(1)
    expect(mocks.setRemoteControlEnabled).toHaveBeenCalledWith(false, expect.any(Number))
    expect(mocks.setRemoteControlEnabled.mock.calls.some(([enabled]) => enabled === true)).toBe(
      false,
    )
    expect(mocks.flushProjectsState).toHaveBeenCalledTimes(1)
    expect(mocks.pushToast).toHaveBeenCalledWith({
      title: 'Remote control could not start',
      body: expect.stringContaining('read-only sync failed'),
    })
  })

  it('rolls back when the backend does not report active listeners', async () => {
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: false })

    renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    })
    expect(mocks.pushToast).toHaveBeenCalledWith({
      title: 'Remote control could not start',
      body: expect.stringContaining('did not report active listeners'),
    })
  })

  it('sends disable immediately while an older enable request is still pending', async () => {
    let resolveEnable!: (value: { enabled: boolean }) => void
    const enablePending = new Promise<{ enabled: boolean }>((resolve) => {
      resolveEnable = resolve
    })
    mocks.setRemoteControlEnabled.mockImplementation((enabled: boolean) =>
      enabled ? enablePending : Promise.resolve({ enabled: false }),
    )

    const { rerender } = renderHook(() => useRemoteControlService())
    await waitFor(() => {
      expect(mocks.setRemoteControlEnabled).toHaveBeenCalledWith(true, expect.any(Number))
    })

    ;(mocks.projectState.preferences as Record<string, unknown>).remoteEnabled = false
    rerender()

    await waitFor(() => {
      expect(mocks.setRemoteControlEnabled).toHaveBeenCalledWith(false, expect.any(Number))
    })
    expect(
      mocks.setRemoteControlEnabled.mock.calls.filter(([enabled]) => enabled === false),
    ).toHaveLength(1)

    resolveEnable({ enabled: true })
    await enablePending
  })

  it('reports when the disabled preference cannot be persisted', async () => {
    mocks.setRemoteControlEnabled.mockRejectedValueOnce(new Error('ports unavailable'))
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: false })
    mocks.flushProjectsState.mockRejectedValueOnce(new Error('disk unavailable'))

    renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control rollback needs attention',
        body: expect.stringContaining('disk unavailable'),
      })
    })
    expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
  })
})
