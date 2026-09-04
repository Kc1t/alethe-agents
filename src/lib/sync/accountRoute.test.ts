import { describe, expect, it } from 'vitest'

import { computeAccountRouteId } from './accountRoute'

describe('computeAccountRouteId', () => {
  it('matches the fixed cross-language vector for a known account id', async () => {
    // Same input/output pair asserted by the Rust side (`sync_protocol::tests`), computed
    // independently with SHA-256("alethe-account-route-v1" + "acct-owner").
    await expect(computeAccountRouteId('acct-owner')).resolves.toBe(
      'fb656d1fd22a71da157f6959877b97c105fa3efe799b4646fd6fbc20105d555b',
    )
  })

  it('is deterministic and never leaks the input account id', async () => {
    const first = await computeAccountRouteId('google-sub-a')
    const second = await computeAccountRouteId('google-sub-a')
    const other = await computeAccountRouteId('google-sub-b')
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toHaveLength(64)
    expect(first).not.toContain('google-sub-a')
  })
})
