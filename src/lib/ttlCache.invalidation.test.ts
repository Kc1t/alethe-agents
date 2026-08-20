import { describe, expect, it, vi } from 'vitest'

import { clearAllTtlCaches, makeKeyedTtlCache, makeTtlCache } from './ttlCache'

describe('clearAllTtlCaches', () => {
  it('makes the next read refetch instead of serving the memoised value', async () => {
    const fetcher = vi.fn(async () => 'value')
    const read = makeTtlCache(fetcher, 60_000)

    await read()
    await read()
    expect(fetcher, 'the second read is served from cache').toHaveBeenCalledTimes(1)

    clearAllTtlCaches()
    await read()
    expect(
      fetcher,
      'after dropping caches the value has to be fetched again',
    ).toHaveBeenCalledTimes(2)
  })

  it('also drops keyed caches', async () => {
    const fetcher = vi.fn(async (key: string) => key.toUpperCase())
    const read = makeKeyedTtlCache(fetcher, 60_000)

    await read('a')
    await read('a')
    expect(fetcher).toHaveBeenCalledTimes(1)

    clearAllTtlCaches()
    await read('a')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('clears every cache, not only the most recent one', async () => {
    const first = vi.fn(async () => 1)
    const second = vi.fn(async () => 2)
    const readFirst = makeTtlCache(first, 60_000)
    const readSecond = makeTtlCache(second, 60_000)

    await readFirst()
    await readSecond()
    clearAllTtlCaches()
    await readFirst()
    await readSecond()

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
  })
})
