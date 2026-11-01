import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listenRemoteAutoDisabled: vi.fn(),
  listenRemoteMessages: vi.fn(),
  listenRemoteOpenAgent: vi.fn(),
  listenRemoteStartFailed: vi.fn(),
  flushProjectsState: vi.fn(),
  projectState: {} as Record<string, unknown>,
  pushToast: vi.fn(),
  setPreferences: vi.fn(),
  setRemoteControlEnabled: vi.fn(),
  setRemoteControlMaxDevices: vi.fn(),
  setRemoteControlReachMode: vi.fn(),
  setRemoteControlReadOnly: vi.fn(),
  setRemoteControlSessionExpiry: vi.fn(),
  setRemoteControlShellInput: vi.fn(),
}))

vi.mock('../lib/tauri', () => ({
  listenRemoteAutoDisabled: mocks.listenRemoteAutoDisabled,
  listenRemoteMessages: mocks.listenRemoteMessages,
  listenRemoteOpenAgent: mocks.listenRemoteOpenAgent,
  listenRemoteStartFailed: mocks.listenRemoteStartFailed,
  setRemoteControlEnabled: mocks.setRemoteControlEnabled,
  setRemoteControlMaxDevices: mocks.setRemoteControlMaxDevices,
  setRemoteControlReachMode: mocks.setRemoteControlReachMode,
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

function preferences() {
  return mocks.projectState.preferences as Record<string, unknown>
}

function enableCalls() {
  return mocks.setRemoteControlEnabled.mock.calls.filter(([enabled]) => enabled === true)
}

function disableCalls() {
  return mocks.setRemoteControlEnabled.mock.calls.filter(([enabled]) => enabled === false)
}

/**
 * Mounts the hook with Remote Control off (as after every app start), waits
 * for the startup disable, then flips the preference on like a user would.
 * `arrange` runs in between, to stage failures for the enable attempt only.
 */
async function mountAndEnable(arrange?: () => void) {
  const view = renderHook(() => useRemoteControlService())
  await waitFor(() => expect(disableCalls()).toHaveLength(1))
  mocks.setRemoteControlEnabled.mockClear()
  arrange?.()
  preferences().remoteEnabled = true
  view.rerender()
  return view
}

describe('useRemoteControlService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    const state = {
      language: 'en',
      remoteAllowShellInput: false,
      remoteEnabled: false,
      remoteMaxDevices: 1,
      remoteReadOnly: true,
      remoteSessionExpirySecs: 3_600,
      remoteUseTailscale: false,
    }
    mocks.setPreferences.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(state, patch)
    })
    mocks.projectState = {
      hydrated: true,
      preferences: state,
      setPreferences: mocks.setPreferences,
    }
    mocks.listenRemoteAutoDisabled.mockResolvedValue(vi.fn())
    mocks.listenRemoteMessages.mockResolvedValue(vi.fn())
    mocks.listenRemoteOpenAgent.mockResolvedValue(vi.fn())
    mocks.listenRemoteStartFailed.mockResolvedValue(vi.fn())
    mocks.flushProjectsState.mockResolvedValue(undefined)
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: false })
    mocks.setRemoteControlMaxDevices.mockResolvedValue({})
    mocks.setRemoteControlSessionExpiry.mockResolvedValue({})
    mocks.setRemoteControlReadOnly.mockResolvedValue({})
    mocks.setRemoteControlShellInput.mockResolvedValue({})
    mocks.setRemoteControlReachMode.mockResolvedValue({})
  })

  it('never reopens a listener from a preference saved by a previous session', async () => {
    preferences().remoteEnabled = true

    const { rerender } = renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.setRemoteControlEnabled).toHaveBeenCalledWith(false, expect.any(Number))
    })
    expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    rerender()
    await waitFor(() => expect(disableCalls().length).toBeGreaterThanOrEqual(1))
    expect(enableCalls()).toHaveLength(0)
    expect(mocks.setRemoteControlReadOnly).not.toHaveBeenCalled()
  })

  it('applies every policy before enabling and keeps the preference on success', async () => {
    mocks.setRemoteControlEnabled.mockResolvedValue({ enabled: true })

    await mountAndEnable()

    await waitFor(() => expect(enableCalls()).toHaveLength(1))
    const enableOrder = mocks.setRemoteControlEnabled.mock.invocationCallOrder[0]
    for (const setter of [
      mocks.setRemoteControlMaxDevices,
      mocks.setRemoteControlSessionExpiry,
      mocks.setRemoteControlReadOnly,
      mocks.setRemoteControlShellInput,
      mocks.setRemoteControlReachMode,
    ]) {
      expect(setter).toHaveBeenCalledTimes(1)
      expect(setter.mock.invocationCallOrder[0]).toBeLessThan(enableOrder)
    }
    expect(mocks.setPreferences).not.toHaveBeenCalled()
    expect(mocks.pushToast).not.toHaveBeenCalled()
  })

  it('rolls back only remoteEnabled, reports enable failure, and does not retry', async () => {
    const { rerender } = await mountAndEnable(() => {
      mocks.setRemoteControlEnabled.mockRejectedValueOnce(new Error('ports unavailable'))
    })

    await waitFor(() => {
      expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    })
    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control could not start',
        body: expect.stringContaining('ports unavailable'),
      })
    })
    expect(mocks.setRemoteControlEnabled).toHaveBeenNthCalledWith(1, true, expect.any(Number))
    expect(mocks.setRemoteControlEnabled).toHaveBeenNthCalledWith(2, false, expect.any(Number))
    expect(mocks.flushProjectsState).toHaveBeenCalledTimes(1)

    rerender()
    await waitFor(() => expect(disableCalls()).toHaveLength(2))
    rerender()

    expect(enableCalls()).toHaveLength(1)
    expect(mocks.setPreferences).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a security setting cannot be applied', async () => {
    mocks.setRemoteControlReadOnly.mockRejectedValueOnce(new Error('read-only sync failed'))

    await mountAndEnable()

    await waitFor(() => {
      expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
    })
    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control could not start',
        body: expect.stringContaining('read-only sync failed'),
      })
    })
    expect(enableCalls()).toHaveLength(0)
    expect(disableCalls()).toHaveLength(1)
    expect(mocks.flushProjectsState).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the reach mode cannot be applied', async () => {
    mocks.setRemoteControlReachMode.mockRejectedValueOnce(new Error('no Tailscale address'))

    await mountAndEnable()

    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control could not start',
        body: expect.stringContaining('no Tailscale address'),
      })
    })
    expect(enableCalls()).toHaveLength(0)
    expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
  })

  it('rolls back when the backend does not report active listeners', async () => {
    await mountAndEnable()

    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control could not start',
        body: expect.stringContaining('did not report active listeners'),
      })
    })
    expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
  })

  it('sends disable immediately while an older enable request is still pending', async () => {
    let resolveEnable!: (value: { enabled: boolean }) => void
    const enablePending = new Promise<{ enabled: boolean }>((resolve) => {
      resolveEnable = resolve
    })
    mocks.setRemoteControlEnabled.mockImplementation((enabled: boolean) =>
      enabled ? enablePending : Promise.resolve({ enabled: false }),
    )

    const { rerender } = await mountAndEnable()
    await waitFor(() => expect(enableCalls()).toHaveLength(1))

    preferences().remoteEnabled = false
    rerender()

    await waitFor(() => expect(disableCalls()).toHaveLength(1))
    const [[, enableId]] = enableCalls()
    const [[, disableId]] = disableCalls()
    expect(disableId).toBeGreaterThan(enableId)

    resolveEnable({ enabled: true })
    await enablePending
    expect(mocks.setPreferences).not.toHaveBeenCalled()
    expect(mocks.pushToast).not.toHaveBeenCalled()
  })

  it('reports when the disabled preference cannot be persisted', async () => {
    await mountAndEnable(() => {
      mocks.setRemoteControlEnabled.mockRejectedValueOnce(new Error('ports unavailable'))
      mocks.flushProjectsState.mockRejectedValueOnce(new Error('disk unavailable'))
    })

    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control rollback needs attention',
        body: expect.stringContaining('disk unavailable'),
      })
    })
    expect(mocks.setPreferences).toHaveBeenCalledWith({ remoteEnabled: false })
  })

  it('reports when the listeners cannot be confirmed stopped', async () => {
    mocks.setRemoteControlEnabled.mockImplementation((enabled: boolean) =>
      enabled ? Promise.resolve({ enabled: true }) : Promise.reject(new Error('ipc closed')),
    )

    const { rerender } = renderHook(() => useRemoteControlService())

    await waitFor(() => {
      expect(mocks.pushToast).toHaveBeenCalledWith({
        title: 'Remote control could not stop',
        body: expect.stringContaining('ipc closed'),
      })
    })
    rerender()
  })
})
