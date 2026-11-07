import { describe, expect, it } from 'vitest'

import { etaSeconds, formatByteSize, formatDuration, formatRate, nextRate } from './downloadStats'

describe('nextRate', () => {
  it('needs two samples before it knows a speed', () => {
    const first = nextRate(null, { bytes: 0, at: 0 })
    expect(first.bytesPerSecond).toBeNull()
    const second = nextRate(first, { bytes: 1_000_000, at: 1_000 })
    expect(second.bytesPerSecond).toBe(1_000_000)
  })

  it('smooths a single slow sample instead of following it', () => {
    let rate = nextRate(null, { bytes: 0, at: 0 })
    rate = nextRate(rate, { bytes: 10_000_000, at: 1_000 })
    rate = nextRate(rate, { bytes: 10_100_000, at: 2_000 })
    expect(rate.bytesPerSecond).toBeGreaterThan(5_000_000)
    expect(rate.bytesPerSecond).toBeLessThan(10_000_000)
  })

  it('starts over when the byte count goes back (a new download)', () => {
    let rate = nextRate(null, { bytes: 0, at: 0 })
    rate = nextRate(rate, { bytes: 5_000_000, at: 1_000 })
    rate = nextRate(rate, { bytes: 100, at: 1_500 })
    expect(rate.bytesPerSecond).toBeNull()
  })

  it('ignores a sample with no elapsed time', () => {
    let rate = nextRate(null, { bytes: 0, at: 0 })
    rate = nextRate(rate, { bytes: 1_000, at: 0 })
    expect(rate.bytesPerSecond).toBeNull()
  })
})

describe('etaSeconds', () => {
  it('divides what is left by the speed, rounding up', () => {
    expect(etaSeconds(10_000_000, 3_000_000)).toBe(4)
  })

  it('has no estimate without a speed', () => {
    expect(etaSeconds(10, null)).toBeNull()
    expect(etaSeconds(10, 0)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats sizes with a localized unit', () => {
    expect(formatByteSize(652_184_281, 'en-US')).toBe('652.2 MB')
    expect(formatByteSize(1_500_000_000, 'en-US')).toBe('1.5 GB')
    expect(formatByteSize(512_000, 'en-US')).toBe('512 kB')
    expect(formatByteSize(652_184_281, 'pt-BR')).toBe('652,2 MB')
  })

  it('formats a speed per second', () => {
    expect(formatRate(8_400_000, 'en-US')).toBe('8.4 MB/s')
  })

  it('formats a duration in the largest useful units', () => {
    expect(formatDuration(45, 'en-US')).toBe('45 sec')
    expect(formatDuration(200, 'en-US')).toBe('3 min 20 sec')
    expect(formatDuration(3_900, 'en-US')).toBe('1 hr 5 min')
  })
})
