import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canUseSharedCoreTransport,
  CORE_IDENTITY_MISMATCH,
  CORE_TRANSIENT_ERROR,
  type CoreStorageIdentity,
  matchesCoreIdentity,
  resetCoreTransportStateForTests,
  webApiFetch,
} from './transport'

const localIdentity: CoreStorageIdentity = {
  app_identifier: 'com.kc1t.alethe.dev',
  data_root_id: 'root-a',
}

afterEach(() => {
  resetCoreTransportStateForTests()
  vi.unstubAllGlobals()
})

describe('matchesCoreIdentity', () => {
  it('accepts the shared core for the same identifier and data root', () => {
    expect(
      matchesCoreIdentity(localIdentity, {
        status: 'ok',
        service: 'alethe-core',
        runtime: {
          service: 'alethe-core',
          appIdentifier: 'com.kc1t.alethe.dev',
          dataRootId: 'root-a',
        },
      }),
    ).toBe(true)
  })

  it('rejects a server that points at a different data root', () => {
    expect(
      matchesCoreIdentity(localIdentity, {
        status: 'ok',
        service: 'alethe-core',
        runtime: {
          appIdentifier: 'com.kc1t.alethe.dev',
          dataRootId: 'root-b',
        },
      }),
    ).toBe(false)
  })

  it('rejects a production core from a development client', () => {
    expect(
      matchesCoreIdentity(localIdentity, {
        status: 'ok',
        service: 'alethe-core',
        runtime: {
          appIdentifier: 'com.kc1t.alethe',
          dataRootId: 'root-a',
        },
      }),
    ).toBe(false)
  })

  it('rejects a service that only imitates the expected storage identity', () => {
    expect(
      matchesCoreIdentity(localIdentity, {
        status: 'ok',
        service: 'another-service',
        runtime: {
          appIdentifier: 'com.kc1t.alethe.dev',
          dataRootId: 'root-a',
        },
      }),
    ).toBe(false)
  })

  it('uses the authenticated browser authority after its identity matches', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'ok',
            service: 'alethe-core',
            runtime: {
              appIdentifier: 'com.kc1t.alethe.dev',
              dataRootId: 'browser-root',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'session-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ active_profile_id: 'default', profiles: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(webApiFetch('/api/profiles/list')).resolves.toEqual({
      active_profile_id: 'default',
      profiles: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/health')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/session')
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer session-token' }),
    })
  })

  it('checks the browser core identity before requesting an authenticated session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          service: 'alethe-core',
          runtime: {
            appIdentifier: 'com.kc1t.alethe',
            dataRootId: 'production-root',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(webApiFetch('/api/profiles/list')).rejects.toThrow(CORE_IDENTITY_MISMATCH)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/health')
  })

  it('revalidates identity before refreshing authentication after a core restart', async () => {
    const health = (appIdentifier: string) =>
      new Response(
        JSON.stringify({
          status: 'ok',
          service: 'alethe-core',
          runtime: { appIdentifier, dataRootId: 'root' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(health('com.kc1t.alethe.dev'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'old-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('authentication_required', { status: 401 }))
      .mockResolvedValueOnce(health('com.kc1t.alethe'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(webApiFetch('/api/profiles/list')).rejects.toThrow(CORE_IDENTITY_MISMATCH)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('revalidates identity and rotates a session when its refresh window opens', async () => {
    const now = Date.now()
    const health = new Response(
      JSON.stringify({
        status: 'ok',
        service: 'alethe-core',
        runtime: {
          appIdentifier: 'com.kc1t.alethe.dev',
          dataRootId: 'development-root',
          instanceId: 'core-a',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
    const session = (token: string, generation: number) =>
      new Response(
        JSON.stringify({
          token,
          generation,
          instanceId: 'core-a',
          refreshAfterMs: generation === 1 ? now - 1 : now + 60_000,
          expiresAtMs: now + 120_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    const ok = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce(session('first-token', 1))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(health.clone())
      .mockResolvedValueOnce(session('second-token', 2))
      .mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)

    await webApiFetch('/api/profiles/list')
    await webApiFetch('/api/profiles/list')

    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer first-token',
    })
    expect(fetchMock.mock.calls[5]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer second-token',
    })
  })

  it('returns false (not an error) when the initial discovery probe fails before authority exists', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(canUseSharedCoreTransport()).resolves.toBe(false)
  })

  it('keeps HTTP authority sticky: a transient failure after establishment throws instead of falling back', async () => {
    vi.useFakeTimers()
    try {
      const health = () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            service: 'alethe-core',
            runtime: { appIdentifier: 'com.kc1t.alethe.dev', dataRootId: 'root-a' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(health())
        .mockRejectedValueOnce(new Error('network hiccup'))
      vi.stubGlobal('fetch', fetchMock)

      await expect(canUseSharedCoreTransport()).resolves.toBe(true)

      // Advance past the short-lived "available" cache window so the next
      // call performs a real probe instead of serving the cached result.
      await vi.advanceTimersByTimeAsync(5001)

      await expect(canUseSharedCoreTransport()).rejects.toThrow(CORE_TRANSIENT_ERROR)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
