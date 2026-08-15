import { describe, expect, it } from 'vitest'

import { isOutdated, npmPackageFor } from './agentVersions'

describe('npmPackageFor', () => {
  it('reads the package out of the documented install command', () => {
    expect(npmPackageFor('freebuff')).toBe('freebuff')
    expect(npmPackageFor('mimo')).toBe('@mimo-ai/cli')
    expect(npmPackageFor('claude')).toBe('@anthropic-ai/claude-code')
  })

  it('returns nothing for agents that ship no npm installer', () => {
    expect(npmPackageFor('antigravity')).toBeUndefined()
    expect(npmPackageFor('shell')).toBeUndefined()
  })
})

describe('isOutdated', () => {
  it('compares releases numerically, not lexically', () => {
    expect(isOutdated('1.9.0', '1.10.0')).toBe(true)
    expect(isOutdated('1.10.0', '1.9.0')).toBe(false)
    expect(isOutdated('2.0.0', '2.0.0')).toBe(false)
  })

  it('tolerates a leading v and uneven segment counts', () => {
    expect(isOutdated('v1.2', '1.2.1')).toBe(true)
    expect(isOutdated('1.2.1', 'v1.2')).toBe(false)
  })

  it('ignores prerelease suffixes', () => {
    expect(isOutdated('1.2.0-beta.3', '1.2.0')).toBe(false)
    expect(isOutdated('1.2.0', '1.3.0-rc.1')).toBe(true)
  })
})
