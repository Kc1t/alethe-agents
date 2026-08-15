import { describe, expect, it } from 'vitest'

import { browserHiddenEvictionDelay } from './browserResourcePolicy'

describe('browserHiddenEvictionDelay', () => {
  it('releases hidden app-first browsers quickly', () => {
    expect(browserHiddenEvictionDelay('app-first', 'normal')).toBe(1_000)
  })

  it('keeps balanced and keep-alive modes distinct without memory pressure', () => {
    expect(browserHiddenEvictionDelay('balanced', 'normal')).toBe(30_000)
    expect(browserHiddenEvictionDelay('keep-alive', 'normal')).toBeNull()
  })

  it('always prioritizes the app under memory pressure', () => {
    expect(browserHiddenEvictionDelay('balanced', 'warning')).toBe(0)
    expect(browserHiddenEvictionDelay('keep-alive', 'critical')).toBe(0)
  })
})
