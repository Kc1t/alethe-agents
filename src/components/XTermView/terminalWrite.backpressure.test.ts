import { describe, expect, it } from 'vitest'

import { MAX_PENDING_WRITE_BYTES, trimPendingWrites } from './terminalWrite'

const chunk = (size: number, fill = 'x') => fill.repeat(size)

describe('trimPendingWrites', () => {
  it('leaves an ordinary backlog alone', () => {
    const pending = [chunk(1000), chunk(2000)]
    const result = trimPendingWrites(pending, 3000)

    expect(result.dropped).toBe(0)
    expect(pending).toHaveLength(2)
    expect(result.length).toBe(3000)
  })

  it('drops the oldest output once the backlog outgrows the cap', () => {
    // A PTY hands over 64 KB per batch while a frame drains 16 KB, so a noisy command buries the
    // terminal in output it will not reach for minutes.
    const pending = Array.from({ length: 20 }, () => chunk(64 * 1024))
    const total = 20 * 64 * 1024

    const result = trimPendingWrites(pending, total)

    expect(result.length).toBeLessThanOrEqual(MAX_PENDING_WRITE_BYTES)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.length).toBe(
      pending.reduce((sum, entry) => sum + entry.length, 0),
      // the reported length has to match what is actually left, or the flush loop miscounts
    )
  })

  it('keeps the newest output, which is the part worth showing', () => {
    const pending = [chunk(400 * 1024, 'a'), chunk(400 * 1024, 'b'), chunk(400 * 1024, 'c')]

    trimPendingWrites(pending, 1200 * 1024)

    expect(pending[pending.length - 1]!.startsWith('c')).toBe(true)
    expect(pending.some((entry) => entry.startsWith('a'))).toBe(false)
  })

  it('never empties the queue completely', () => {
    // Dropping the only chunk would discard output the terminal has not shown at all.
    const pending = [chunk(4 * MAX_PENDING_WRITE_BYTES)]
    const result = trimPendingWrites(pending, 4 * MAX_PENDING_WRITE_BYTES)

    expect(pending).toHaveLength(1)
    expect(result.dropped).toBe(0)
  })

  it('drops whole chunks so an escape sequence is never cut in half', () => {
    const pending = [chunk(300 * 1024, 'a'), chunk(300 * 1024, 'b'), chunk(300 * 1024, 'c')]

    trimPendingWrites(pending, 900 * 1024)

    for (const entry of pending) {
      expect(new Set(entry).size, 'a surviving chunk must be intact').toBe(1)
    }
  })
})
