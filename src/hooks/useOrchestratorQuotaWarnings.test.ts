import { describe, expect, it } from 'vitest'

import { quotaWarningForFitness } from './useOrchestratorQuotaWarnings'

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
