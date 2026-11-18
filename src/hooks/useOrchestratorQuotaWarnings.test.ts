import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { quotaWindowLabel } from '../lib/agentFitness'
import { loadClaudeUsage } from '../lib/claudeUsageCache'
import { type TFunction, translate } from '../lib/i18n'
import type { ClaudeUsage } from '../lib/tauri'
import { clearAllTtlCaches } from '../lib/ttlCache'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import {
  quotaWarningForFitness,
  useOrchestratorQuotaWarnings,
} from './useOrchestratorQuotaWarnings'

const { getClaudeUsage, getAntigravityUsage, setAgentFitness } = vi.hoisted(() => ({
  getClaudeUsage: vi.fn(),
  getAntigravityUsage: vi.fn(),
  setAgentFitness: vi.fn(async () => undefined),
}))
vi.mock('../lib/tauri', () => ({ getClaudeUsage, getAntigravityUsage, setAgentFitness }))
vi.mock('../lib/codexUsageCache', () => ({ getCachedCodexUsage: vi.fn() }))

const t: TFunction = (key, params) => translate('en', key, params)

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '2026-09-29T20:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2026-10-01T09:00:00Z' },
  seven_day_opus: { utilization: 0, resets_at: '' },
}

beforeEach(() => {
  clearAllTtlCaches()
  getClaudeUsage.mockReset()
  getAntigravityUsage.mockReset()
  setAgentFitness.mockClear()
  const file = structuredClone(EMPTY_PROJECTS_FILE)
  file.preferences.usageAccess = { ...file.preferences.usageAccess, claude: true, codex: false }
  useProjectsStore.setState({ ...file, hydrated: true })
  useUiStore.setState({ claudeUsage: null, claudeUsageError: null })
})

// The usage API rate limits readily: every reader shares one request, or the top bar never gets a
// first reading and its Claude indicator stays hidden.
describe('useOrchestratorQuotaWarnings', () => {
  it('shares one Claude usage request with the top bar and other orchestration panes', async () => {
    getClaudeUsage.mockResolvedValue(reading)

    renderHook(() => useOrchestratorQuotaWarnings())
    renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() =>
      expect(setAgentFitness.mock.calls.filter(([agent]) => agent === 'claude')).toHaveLength(2),
    )
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })

  it('puts the reading it takes on the top bar', async () => {
    getClaudeUsage.mockResolvedValue(reading)

    renderHook(() => useOrchestratorQuotaWarnings())

    await waitFor(() => expect(useUiStore.getState().claudeUsage).toEqual(reading))
  })

  // Antigravity workers (#218): one vendor reading, read only while its usage reading is on.
  const onlyAntigravity = (antigravity: boolean) => {
    const { preferences } = useProjectsStore.getState()
    useProjectsStore.setState({
      preferences: {
        ...preferences,
        usageAccess: {
          ...preferences.usageAccess,
          claude: false,
          codex: false,
          antigravity,
        },
      },
    })
  }
  const agyBucket = (label: string, used_percent: number) => ({
    label,
    models: [],
    used_percent,
    remaining_percent: 100 - used_percent,
    resets_at: '',
  })

  it('reports the Antigravity quota to the orchestrator and warns on its tightest bucket', async () => {
    onlyAntigravity(true)
    getAntigravityUsage.mockResolvedValue({
      status: 'ready',
      cli_path: 'agy',
      used_percent: 92,
      rate_limited: false,
      buckets: [agyBucket('Gemini Flash', 10), agyBucket('Claude', 92)],
    })
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(result.current).toHaveLength(1))

    expect(result.current[0]).toMatchObject({ agent: 'antigravity', pct: 92, window: 'Claude' })
    expect(setAgentFitness).toHaveBeenCalledWith(
      'antigravity',
      expect.objectContaining({
        worst: 'Claude',
        used: 92,
        windows: { 'Gemini Flash': 10, Claude: 92 },
      }),
    )
    // A bucket is not a weekly window.
    expect(quotaWindowLabel('Claude', t, 'antigravity')).toBe('Claude quota')
  })

  it('does not hand the core a reading that arrives after Antigravity was turned off', async () => {
    onlyAntigravity(true)
    let arrive: (usage: unknown) => void = () => undefined
    getAntigravityUsage.mockReturnValue(new Promise((resolve) => (arrive = resolve)))
    renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(getAntigravityUsage).toHaveBeenCalled())

    act(() => onlyAntigravity(false))
    await waitFor(() => expect(setAgentFitness).toHaveBeenCalledWith('antigravity', null))
    await act(async () =>
      arrive({
        status: 'ready',
        cli_path: 'agy',
        used_percent: 92,
        rate_limited: false,
        buckets: [agyBucket('Claude', 92)],
      }),
    )

    const published = setAgentFitness.mock.calls.filter(([agent]) => agent === 'antigravity')
    expect(published.at(-1)).toEqual(['antigravity', null])
  })

  it('forgets the Antigravity reading while its usage reading is off or not ready', async () => {
    onlyAntigravity(false)
    const off = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(setAgentFitness).toHaveBeenCalledWith('antigravity', null))
    expect(getAntigravityUsage).not.toHaveBeenCalled()
    off.unmount()

    setAgentFitness.mockClear()
    onlyAntigravity(true)
    getAntigravityUsage.mockResolvedValue({
      status: 'no_auth',
      cli_path: 'agy',
      used_percent: 0,
      rate_limited: false,
      buckets: [],
    })
    const { result } = renderHook(() => useOrchestratorQuotaWarnings())
    await waitFor(() => expect(getAntigravityUsage).toHaveBeenCalled())
    await waitFor(() => expect(setAgentFitness).toHaveBeenCalledWith('antigravity', null))
    expect(result.current).toEqual([])
  })
})

describe('quotaWarningForFitness', () => {
  it('does not warn while the raw worst window is below the threshold, even when it rounds up to it', () => {
    const warning = quotaWarningForFitness('claude', {
      worst: 'fable',
      used: 80,
      resetsAt: 'later',
      rateLimited: false,
      windows: { '5h': 10, fable: 79.6 },
    })
    expect(warning).toBeNull()
  })

  it('warns at the raw threshold and preserves the triggering window', () => {
    expect(
      quotaWarningForFitness('codex', {
        worst: 'week',
        used: 80,
        resetsAt: 'later',
        rateLimited: false,
        windows: { '5h': 12, week: 80 },
      }),
    ).toEqual({ agent: 'codex', pct: 80, resetsAt: 'later', window: 'week' })
  })
})
