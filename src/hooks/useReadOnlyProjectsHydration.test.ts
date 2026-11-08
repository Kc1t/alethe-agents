import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useReadOnlyProjectsHydration } from './useReadOnlyProjectsHydration'

const mocks = vi.hoisted(() => ({
  hydrate: vi.fn(),
  unlisten: vi.fn(),
  handler: null as null | (() => void),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, handler: () => void) => {
    mocks.handler = handler
    return mocks.unlisten
  },
}))
vi.mock('../stores/projectsStore', () => ({
  useProjectsStore: (selector: (s: unknown) => unknown) => selector({ hydrate: mocks.hydrate }),
}))

describe('useReadOnlyProjectsHydration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.handler = null
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('hydrates once, then once per burst of saves', async () => {
    renderHook(() => useReadOnlyProjectsHydration())
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.hydrate).toHaveBeenCalledTimes(1)
    mocks.handler?.()
    mocks.handler?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.hydrate).toHaveBeenCalledTimes(2)
  })

  it('hydrates only once when reloads on save are off', async () => {
    renderHook(() => useReadOnlyProjectsHydration({ reloadOnSave: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.hydrate).toHaveBeenCalledTimes(1)
    expect(mocks.handler).toBeNull()
  })

  it('unlistens on cleanup', async () => {
    const { unmount } = renderHook(() => useReadOnlyProjectsHydration())
    await vi.advanceTimersByTimeAsync(0)
    unmount()
    expect(mocks.unlisten).toHaveBeenCalled()
  })
})
