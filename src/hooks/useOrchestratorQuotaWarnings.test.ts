import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadClaudeUsage } from '../lib/claudeUsageCache'
import type { ClaudeUsage } from '../lib/tauri'
import { clearAllTtlCaches } from '../lib/ttlCache'
import { EMPTY_PROJECTS_FILE } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { useUiStore } from '../stores/uiStore'
import { useOrchestratorQuotaWarnings } from './useOrchestratorQuotaWarnings'

const { getClaudeUsage, setAgentFitness } = vi.hoisted(() => ({
  getClaudeUsage: vi.fn(),
  setAgentFitness: vi.fn(async () => undefined),
}))
vi.mock('../lib/tauri', () => ({ getClaudeUsage, setAgentFitness }))
vi.mock('../lib/codexUsageCache', () => ({ getCachedCodexUsage: vi.fn() }))

const reading: ClaudeUsage = {
  five_hour: { utilization: 34, resets_at: '2026-09-29T20:00:00Z' },
  seven_day: { utilization: 46, resets_at: '2026-10-01T09:00:00Z' },
  seven_day_opus: { utilization: 0, resets_at: '' },
}

beforeEach(() => {
  clearAllTtlCaches()
  getClaudeUsage.mockReset()
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
    await waitFor(() => expect(setAgentFitness).toHaveBeenCalledTimes(2))
    await loadClaudeUsage()

    expect(getClaudeUsage).toHaveBeenCalledTimes(1)
  })

  it('puts the reading it takes on the top bar', async () => {
    getClaudeUsage.mockResolvedValue(reading)

    renderHook(() => useOrchestratorQuotaWarnings())

    await waitFor(() => expect(useUiStore.getState().claudeUsage).toEqual(reading))
  })
})
