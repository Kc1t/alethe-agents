import { describe, expect, it } from 'vitest'

import { shouldAutoFit } from './orchestratorViewPolicy'

describe('shouldAutoFit', () => {
  it('allows the initial fit', () => {
    expect(shouldAutoFit(false, false)).toBe(true)
  })

  it('suspends re-measure and resize fits while hovered or after a pan', () => {
    expect(shouldAutoFit(false, true)).toBe(false)
    expect(shouldAutoFit(true, false)).toBe(false)
  })

  it('fits on an explicit tab switch even while hovered or after a previous pan', () => {
    expect(shouldAutoFit(true, true, true)).toBe(true)
  })
})
