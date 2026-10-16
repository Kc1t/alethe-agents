import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HubModelInfo, HubSearchResult } from '../../../../lib/tauri'
import { useHubSearch } from './useHubSearch'

const tauri = vi.hoisted(() => ({
  speechHubSearch: vi.fn(),
  speechHubResolve: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))

const info = (repo: string, extra: Partial<HubModelInfo> = {}): HubModelInfo => ({
  repo,
  commit: null,
  family: 'vits',
  languages: ['pt-BR'],
  languageCount: null,
  multilingual: false,
  speed: 3,
  accuracy: 2,
  voiceCount: 1,
  license: null,
  lastModified: null,
  likes: 1,
  fileCount: null,
  totalBytes: null,
  ...extra,
})
const result = (repo: string): HubSearchResult => ({
  id: `hf:${repo}`,
  use: 'tts',
  label: repo,
  hub: info(repo),
})
const params = {
  use: 'tts' as const,
  query: '',
  language: null,
  sort: 'likes' as const,
  enabled: true,
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  tauri.speechHubSearch.mockResolvedValue({
    results: [result('csukuangfj/a'), result('csukuangfj/b')],
    hasMore: true,
  })
  tauri.speechHubResolve.mockImplementation(async (repo: string) => ({
    ...result(repo),
    hub: info(repo, { commit: 'c'.repeat(40), totalBytes: 80_000_000, fileCount: 360 }),
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('useHubSearch', () => {
  it('searches after the debounce and returns manifests', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    expect(tauri.speechHubSearch).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    expect(tauri.speechHubSearch).toHaveBeenCalledWith({
      use: 'tts',
      query: '',
      language: null,
      sort: 'likes',
      offset: 0,
    })
    expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a', 'hf:csukuangfj/b'])
    expect(hook.current.results[0]).toMatchObject({
      kind: 'download',
      capability: 'tts',
      source: 'huggingface',
    })
  })

  it('resolves rows in the background and fills in the size', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.results[0]?.sizeBytes).toBe(80_000_000))
    expect(hook.current.results[0].hub?.fileCount).toBe(360)
    expect(tauri.speechHubResolve).toHaveBeenCalledWith('csukuangfj/a')
  })

  it('drops a row whose repo turns out incompatible', async () => {
    tauri.speechHubResolve.mockImplementation(async (repo: string) => {
      if (repo === 'csukuangfj/b') throw 'hub_incompatible'
      return result(repo)
    })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a']))
  })

  it('a one-letter query searches like an empty one', async () => {
    renderHook(() => useHubSearch({ ...params, query: 'k' }))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() =>
      expect(tauri.speechHubSearch).toHaveBeenCalledWith({
        use: 'tts',
        query: '',
        language: null,
        sort: 'likes',
        offset: 0,
      }),
    )
  })

  it('reports the error kind and retries', async () => {
    tauri.speechHubSearch.mockRejectedValueOnce('hub_rate_limited')
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('error'))
    expect(hook.current.error).toBe('prefs.voiceHubRateLimited')
    act(() => hook.current.retry())
    await waitFor(() => expect(hook.current.status).toBe('ready'))
  })

  it('load more appends the next page', async () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    tauri.speechHubSearch.mockResolvedValueOnce({
      results: [result('csukuangfj/c')],
      hasMore: false,
    })
    act(() => hook.current.loadMore())
    await waitFor(() => expect(hook.current.results).toHaveLength(3))
    expect(tauri.speechHubSearch).toHaveBeenLastCalledWith({
      use: 'tts',
      query: '',
      language: null,
      sort: 'likes',
      offset: 2,
    })
    expect(hook.current.hasMore).toBe(false)
  })

  it('does not search while disabled', async () => {
    const { result: hook } = renderHook(() => useHubSearch({ ...params, enabled: false }))
    await act(async () => vi.advanceTimersByTime(400))
    expect(tauri.speechHubSearch).not.toHaveBeenCalled()
    expect(hook.current.status).toBe('idle')
    expect(hook.current.results).toEqual([])
  })

  it('load more uses the raw offset after a row is dropped, without duplicates', async () => {
    tauri.speechHubResolve.mockImplementation(async (repo: string) => {
      if (repo === 'csukuangfj/b') throw 'hub_incompatible'
      return result(repo)
    })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a']))
    tauri.speechHubSearch.mockResolvedValueOnce({
      results: [result('csukuangfj/a'), result('csukuangfj/c')],
      hasMore: false,
    })
    act(() => hook.current.loadMore())
    await waitFor(() =>
      expect(hook.current.results.map((m) => m.id)).toEqual(['hf:csukuangfj/a', 'hf:csukuangfj/c']),
    )
    expect(tauri.speechHubSearch).toHaveBeenLastCalledWith({
      use: 'tts',
      query: '',
      language: null,
      sort: 'likes',
      offset: 2,
    })
  })

  it('starts as loading when enabled, with no idle frame first', () => {
    const { result: hook } = renderHook(() => useHubSearch(params))
    expect(hook.current.status).toBe('loading')
  })

  it('resolves only the first 10 rows of a page eagerly', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `csukuangfj/m${i + 1}`)
    tauri.speechHubSearch.mockResolvedValue({ results: repos.map(result), hasMore: false })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    await waitFor(() => expect(hook.current.resolving.size).toBe(0))
    expect(tauri.speechHubResolve).toHaveBeenCalledTimes(10)
    expect(tauri.speechHubResolve).not.toHaveBeenCalledWith('csukuangfj/m11')
    expect(tauri.speechHubResolve).not.toHaveBeenCalledWith('csukuangfj/m12')
  })

  it('resolve(id) checks a later row once', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `csukuangfj/m${i + 1}`)
    tauri.speechHubSearch.mockResolvedValue({ results: repos.map(result), hasMore: false })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    await waitFor(() => expect(hook.current.resolving.size).toBe(0))
    act(() => hook.current.resolve('hf:csukuangfj/m11'))
    act(() => hook.current.resolve('hf:csukuangfj/m11'))
    await waitFor(() =>
      expect(hook.current.results.find((m) => m.id === 'hf:csukuangfj/m11')?.sizeBytes).toBe(
        80_000_000,
      ),
    )
    act(() => hook.current.resolve('hf:csukuangfj/m11'))
    act(() => hook.current.resolve('hf:csukuangfj/m1'))
    expect(
      tauri.speechHubResolve.mock.calls.filter(([repo]) => repo === 'csukuangfj/m11'),
    ).toHaveLength(1)
    expect(
      tauri.speechHubResolve.mock.calls.filter(([repo]) => repo === 'csukuangfj/m1'),
    ).toHaveLength(1)
  })

  it('never checks more than 2 repos at once, across pages', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `csukuangfj/m${i + 1}`)
    tauri.speechHubSearch.mockResolvedValue({ results: repos.map(result), hasMore: true })
    let inFlight = 0
    let peak = 0
    tauri.speechHubResolve.mockImplementation(async (repo: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((done) => setTimeout(done, 5))
      inFlight--
      return result(repo)
    })
    const { result: hook } = renderHook(() => useHubSearch(params))
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    tauri.speechHubSearch.mockResolvedValueOnce({
      results: Array.from({ length: 5 }, (_, i) => result(`csukuangfj/n${i + 1}`)),
      hasMore: false,
    })
    act(() => hook.current.loadMore())
    await waitFor(() => expect(tauri.speechHubResolve).toHaveBeenCalledTimes(15), {
      timeout: 3000,
    })
    await waitFor(() => expect(hook.current.resolving.size).toBe(0))
    expect(peak).toBe(2)
  })

  it('is loading, not ready-and-empty, while the debounce runs after a change', async () => {
    const { result: hook, rerender } = renderHook((p) => useHubSearch(p), { initialProps: params })
    await act(async () => vi.advanceTimersByTime(400))
    await waitFor(() => expect(hook.current.status).toBe('ready'))
    rerender({ ...params, query: 'kokoro' })
    expect(hook.current.status).toBe('loading')
    expect(hook.current.results).toEqual([])
    expect(tauri.speechHubSearch).toHaveBeenCalledTimes(1)
  })
})
