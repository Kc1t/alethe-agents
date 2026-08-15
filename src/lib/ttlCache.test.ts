import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeKeyedTtlCache, makeTtlCache } from './ttlCache'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-08T12:00:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('makeTtlCache', () => {
  it('serve o cache dentro da janela de TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeTtlCache(fetcher, 60_000)

    expect(await cache()).toBe('value')
    expect(await cache()).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refaz a busca depois que o TTL expira', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeTtlCache(fetcher, 60_000)

    await cache()
    await vi.advanceTimersByTimeAsync(60_001)
    await cache()

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('compartilha uma promise em chamadas concorrentes', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeTtlCache(fetcher, 60_000)

    const [a, b] = await Promise.all([cache(), cache()])
    expect(a).toBe('value')
    expect(b).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('force ignora cache e promise em voo', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeTtlCache(fetcher, 60_000)

    await cache()
    await cache(true)

    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('não cacheia rejeição e tenta de novo na próxima chamada', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok')
    const cache = makeTtlCache(fetcher, 60_000)

    await expect(cache()).rejects.toThrow('boom')
    await expect(cache()).resolves.toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('makeKeyedTtlCache', () => {
  it('serve a mesma chave dentro do TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeKeyedTtlCache(fetcher, 60_000)

    expect(await cache('a')).toBe('value')
    expect(await cache('a')).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uma chave diferente invalida a entrada anterior', async () => {
    const fetcher = vi.fn().mockImplementation(async (key: string) => key)
    const cache = makeKeyedTtlCache(fetcher, 60_000)

    expect(await cache('a')).toBe('a')
    expect(await cache('b')).toBe('b')
    expect(await cache('a')).toBe('a')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('compartilha promise apenas para a mesma chave', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const cache = makeKeyedTtlCache(fetcher, 60_000)

    await Promise.all([cache('a'), cache('a')])
    expect(fetcher).toHaveBeenCalledTimes(1)

    await Promise.all([cache('b'), cache('b')])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
