import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCachedClaudeUsage: vi.fn(),
  getCachedCodexUsage: vi.fn(),
  getCachedAntigravityUsage: vi.fn(),
  remoteControlConnectedDevices: vi.fn().mockResolvedValue(0),
  onFocusChanged: vi.fn().mockResolvedValue(() => undefined),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    setTitle: vi.fn(),
    onFocusChanged: mocks.onFocusChanged,
  }),
}))
vi.mock('../../lib/claudeUsageCache', () => ({
  getCachedClaudeUsage: mocks.getCachedClaudeUsage,
}))
vi.mock('../../lib/codexUsageCache', () => ({
  getCachedCodexUsage: mocks.getCachedCodexUsage,
}))
vi.mock('../../lib/antigravityUsageCache', () => ({
  getCachedAntigravityUsage: mocks.getCachedAntigravityUsage,
}))
vi.mock('../../lib/limitResetWatch', () => ({
  observeClaudeReset: vi.fn(),
  observeCodexReset: vi.fn(),
}))
vi.mock('../../hooks/useCloseConfirmation', () => ({ requestAppClose: vi.fn() }))
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  killPty: vi.fn(),
  remoteControlConnectedDevices: mocks.remoteControlConnectedDevices,
}))

import { DEFAULT_PREFERENCES } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { TitleBar } from './index'

const claudeUsage = {
  five_hour: { utilization: 10, resets_at: '2099-01-01T00:00:00Z' },
  seven_day: { utilization: 20, resets_at: '2099-01-01T00:00:00Z' },
  seven_day_opus: { utilization: 30, resets_at: '2099-01-01T00:00:00Z' },
}
const codexUsage = {
  primary: { used_percent: 10, window_minutes: 300, resets_at_ms: 0 },
  secondary: { used_percent: 20, window_minutes: 10_080, resets_at_ms: 0 },
  plan: 'test',
  rate_limited: false,
  reset_credits: 0,
}
const antigravityUsage = {
  status: 'ready' as const,
  cli_path: 'agy',
  used_percent: 10,
  rate_limited: false,
  buckets: [],
}

function setUsagePreferences(patch: Partial<typeof DEFAULT_PREFERENCES>) {
  useProjectsStore.setState((state) => ({
    preferences: { ...state.preferences, ...patch },
  }))
}

describe('TitleBar provider usage polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mocks.getCachedClaudeUsage.mockResolvedValue(claudeUsage)
    mocks.getCachedCodexUsage.mockResolvedValue(codexUsage)
    mocks.getCachedAntigravityUsage.mockResolvedValue(antigravityUsage)
    setUsagePreferences({
      topbarShowClaudeUsage: false,
      topbarShowCodexUsage: false,
      topbarShowAntigravityUsage: false,
    })
    useUiStore.setState({
      claudeUsage,
      codexUsage,
      antigravityUsage,
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
    setUsagePreferences({
      topbarShowClaudeUsage: DEFAULT_PREFERENCES.topbarShowClaudeUsage,
      topbarShowCodexUsage: DEFAULT_PREFERENCES.topbarShowCodexUsage,
      topbarShowAntigravityUsage: DEFAULT_PREFERENCES.topbarShowAntigravityUsage,
    })
  })

  it('clears cached usage and never calls providers while all indicators are disabled', async () => {
    const view = render(<TitleBar />)

    expect(useUiStore.getState()).toMatchObject({
      claudeUsage: null,
      codexUsage: null,
      antigravityUsage: null,
    })

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))

    expect(mocks.getCachedClaudeUsage).not.toHaveBeenCalled()
    expect(mocks.getCachedCodexUsage).not.toHaveBeenCalled()
    expect(mocks.getCachedAntigravityUsage).not.toHaveBeenCalled()
    view.unmount()
  })

  it('starts and cleans up each provider timer independently', async () => {
    setUsagePreferences({
      topbarShowClaudeUsage: true,
      topbarShowCodexUsage: true,
      topbarShowAntigravityUsage: false,
    })
    const view = render(<TitleBar />)

    await act(() => vi.advanceTimersByTimeAsync(2_500))
    expect(mocks.getCachedClaudeUsage).toHaveBeenCalledTimes(1)
    expect(mocks.getCachedCodexUsage).toHaveBeenCalledTimes(1)
    expect(mocks.getCachedAntigravityUsage).not.toHaveBeenCalled()

    act(() => setUsagePreferences({ topbarShowClaudeUsage: false }))
    expect(useUiStore.getState().claudeUsage).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
    expect(mocks.getCachedClaudeUsage).toHaveBeenCalledTimes(1)
    expect(mocks.getCachedCodexUsage).toHaveBeenCalledTimes(2)

    act(() =>
      setUsagePreferences({
        topbarShowCodexUsage: false,
        topbarShowAntigravityUsage: true,
      }),
    )
    expect(useUiStore.getState().codexUsage).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(mocks.getCachedAntigravityUsage).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000))
    expect(mocks.getCachedClaudeUsage).toHaveBeenCalledTimes(1)
    expect(mocks.getCachedCodexUsage).toHaveBeenCalledTimes(2)
    expect(mocks.getCachedAntigravityUsage).toHaveBeenCalledTimes(2)
    view.unmount()
  })
})
