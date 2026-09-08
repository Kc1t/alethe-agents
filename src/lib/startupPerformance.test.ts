import { beforeEach, describe, expect, it } from 'vitest'

import {
  markCoreIdentityVerified,
  markStartup,
  markUiUsable,
  STARTUP_BUDGET_MS,
  STARTUP_MARKS,
  STARTUP_MEASURES,
} from './startupPerformance'

describe('startup performance telemetry', () => {
  beforeEach(() => {
    performance.clearMarks()
    performance.clearMeasures()
  })

  it('records each lifecycle mark only once', () => {
    markStartup(STARTUP_MARKS.bundleEvaluating)
    markStartup(STARTUP_MARKS.bundleEvaluating)
    expect(performance.getEntriesByName(STARTUP_MARKS.bundleEvaluating, 'mark')).toHaveLength(1)
  })

  it('measures verified Core attach and usable UI without payload data', () => {
    markStartup(STARTUP_MARKS.bundleEvaluating)
    markStartup(STARTUP_MARKS.bootstrapRequested)
    markCoreIdentityVerified()
    markUiUsable()

    expect(performance.getEntriesByName(STARTUP_MEASURES.coreAttach, 'measure')).toHaveLength(1)
    expect(performance.getEntriesByName(STARTUP_MEASURES.usableUi, 'measure')).toHaveLength(1)
    expect(JSON.stringify(performance.getEntriesByType('measure'))).not.toContain('project')
  })

  it('keeps the documented warm-start budgets executable', () => {
    expect(STARTUP_BUDGET_MS).toEqual({
      warmCoreAttach: 500,
      warmUsableUi: 2_000,
      compiledStandaloneUsableUi: 3_000,
    })
  })
})
