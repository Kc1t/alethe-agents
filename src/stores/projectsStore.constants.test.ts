import { describe, expect, it } from 'vitest'

import { clampResourceMemoryBudget, RESOURCE_MEMORY_BUDGET_LIMITS } from './projectsStore.constants'

describe('clampResourceMemoryBudget', () => {
  it('supports high-memory workstations without exceeding the supported range', () => {
    expect(clampResourceMemoryBudget(20_000)).toBe(20_000)
    expect(clampResourceMemoryBudget(64_000)).toBe(RESOURCE_MEMORY_BUDGET_LIMITS.max)
  })

  it('normalizes invalid and undersized values', () => {
    expect(clampResourceMemoryBudget(Number.NaN)).toBe(1536)
    expect(clampResourceMemoryBudget(128)).toBe(RESOURCE_MEMORY_BUDGET_LIMITS.min)
  })
})
