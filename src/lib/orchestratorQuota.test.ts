import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  getClaudeUsage: vi.fn(async () => ({})),
  getCodexUsage: vi.fn(async () => ({})),
  setAgentFitness: vi.fn(async () => undefined),
}))

vi.mock('./tauri', () => tauri)
vi.mock('./agentFitness', () => ({
  claudeFitness: () => ({ used: 95, rateLimited: false, resetsAt: '2026-10-03T12:00:00Z' }),
  codexFitness: () => ({ used: 10, rateLimited: false, resetsAt: null }),
}))

import { acquireQuotaPolling, subscribeQuotaWarnings } from './orchestratorQuota'

describe('acquireQuotaPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls once for any number of users and stops when the last one leaves', async () => {
    const releaseRoot = acquireQuotaPolling()
    const releaseBoard = acquireQuotaPolling()
    await vi.runOnlyPendingTimersAsync()
    const callsWhileActive = tauri.getClaudeUsage.mock.calls.length
    expect(callsWhileActive).toBeGreaterThan(0)

    releaseBoard()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(tauri.getClaudeUsage.mock.calls.length).toBeGreaterThan(callsWhileActive)

    releaseRoot()
    const callsAtStop = tauri.getClaudeUsage.mock.calls.length
    await vi.advanceTimersByTimeAsync(600_000)
    expect(tauri.getClaudeUsage.mock.calls.length).toBe(callsAtStop)
  })

  it('feeds the core and warns about the side running out', async () => {
    const seen: unknown[] = []
    const unsubscribe = subscribeQuotaWarnings((warnings) => seen.push(warnings))
    const release = acquireQuotaPolling()
    await vi.runOnlyPendingTimersAsync()

    expect(tauri.setAgentFitness).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ used: 95 }),
    )
    expect(tauri.setAgentFitness).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ used: 10 }),
    )
    expect(seen.at(-1)).toEqual([{ agent: 'claude', pct: 95, resetsAt: '2026-10-03T12:00:00Z' }])

    release()
    unsubscribe()
  })
})
