import { describe, expect, it } from 'vitest'

import { formatGitChangeCount } from './useGitStatusSummary'

describe('formatGitChangeCount', () => {
  it('returns empty string for 0, negative, or invalid numbers', () => {
    expect(formatGitChangeCount(0)).toBe('')
    expect(formatGitChangeCount(-5)).toBe('')
    expect(formatGitChangeCount(Number.NaN)).toBe('')
  })

  it('returns exact count for values under 1000', () => {
    expect(formatGitChangeCount(1)).toBe('1')
    expect(formatGitChangeCount(12)).toBe('12')
    expect(formatGitChangeCount(99)).toBe('99')
    expect(formatGitChangeCount(999)).toBe('999')
  })

  it('formats values of 1000 and above with K+ notation', () => {
    expect(formatGitChangeCount(1000)).toBe('1K+')
    expect(formatGitChangeCount(1050)).toBe('1K+')
    expect(formatGitChangeCount(4000)).toBe('4K+')
    expect(formatGitChangeCount(4230)).toBe('4K+')
    expect(formatGitChangeCount(10000)).toBe('10K+')
    expect(formatGitChangeCount(99999)).toBe('99K+')
  })
})
