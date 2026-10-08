import { describe, expect, it } from 'vitest'

import { requiresTrustConfirmation } from './trust'

describe('when enabling a plugin has to be confirmed', () => {
  it('asks before running anything that arrived on this machine', () => {
    expect(requiresTrustConfirmation('local', true)).toBe(true)
  })

  it('does not ask for what ships with Alethe', () => {
    expect(requiresTrustConfirmation('bundled', true)).toBe(false)
  })

  it('never stands between a person and turning something off', () => {
    // Withdrawing consent is always allowed. A confirmation here would only make a person who
    // already decided to stop a plugin click twice to do it.
    expect(requiresTrustConfirmation('local', false)).toBe(false)
    expect(requiresTrustConfirmation('bundled', false)).toBe(false)
  })
})
