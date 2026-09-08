import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ remoteControlInfo: vi.fn() }))

vi.mock('../lib/tauri', () => ({ remoteControlInfo: api.remoteControlInfo }))

import { useRemoteControl } from './useRemoteControl'

const info = (enabled: boolean) =>
  ({
    enabled,
    pairing_open: false,
  }) as Awaited<ReturnType<typeof api.remoteControlInfo>>

describe('useRemoteControl', () => {
  beforeEach(() => {
    api.remoteControlInfo.mockReset()
    api.remoteControlInfo.mockResolvedValue(info(true))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not poll while its surface is inactive', () => {
    renderHook(() => useRemoteControl(false))
    expect(api.remoteControlInfo).not.toHaveBeenCalled()
  })

  it('loads status and exposes derived state', async () => {
    const { result } = renderHook(() => useRemoteControl())
    await waitFor(() => expect(result.current.info).not.toBeNull())
    expect(result.current.enabled).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('updates shared state through an operation and captures failures', async () => {
    const { result } = renderHook(() => useRemoteControl(false))
    await act(async () => {
      await result.current.run(async () => info(false))
    })
    expect(result.current.enabled).toBe(false)

    await act(async () => {
      await result.current.run(async () => {
        throw new Error('denied')
      })
    })
    expect(result.current.error).toContain('denied')
    expect(result.current.busy).toBe(false)
  })
})
