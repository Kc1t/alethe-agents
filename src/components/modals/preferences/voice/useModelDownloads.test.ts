import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelDownloads } from './useModelDownloads'

const tauri = vi.hoisted(() => ({
  speechListModels: vi.fn(),
  speechModelStates: vi.fn(),
  speechDownloadModel: vi.fn(),
  speechPauseDownload: vi.fn().mockResolvedValue(true),
  speechCancelDownload: vi.fn().mockResolvedValue(undefined),
  speechDeleteModel: vi.fn().mockResolvedValue(undefined),
  onSpeechDownloadProgress: vi.fn(),
}))
vi.mock('../../../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/tauri')>()),
  ...tauri,
}))

let emit: (p: unknown) => void = () => undefined

const progress = (phase: string) => ({
  modelId: 'w',
  phase,
  downloaded: 100,
  total: 100,
  fraction: 1,
  file: 'a',
  fileIndex: 1,
  fileCount: 1,
})

describe('useModelDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauri.speechPauseDownload.mockResolvedValue(true)
    tauri.speechCancelDownload.mockResolvedValue(undefined)
    tauri.speechDeleteModel.mockResolvedValue(undefined)
    tauri.onSpeechDownloadProgress.mockImplementation(async (handler: (p: unknown) => void) => {
      emit = handler
      return () => undefined
    })
    tauri.speechListModels.mockResolvedValue([
      { id: 'w', label: 'W', kind: 'download', capability: 'stt', sizeBytes: 100 },
    ])
  })

  it('shows a paused download read from disk after remount', async () => {
    tauri.speechModelStates.mockResolvedValue([
      { id: 'w', status: 'paused', downloadedBytes: 40, totalBytes: 100 },
    ])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() =>
      expect(result.current.statusOf('w')).toEqual({ kind: 'paused', downloaded: 40, total: 100 }),
    )
  })

  it.each([
    ['a string', 'speech_download_paused'],
    ['an Error', new Error('speech_download_paused')],
  ])('treats a paused rejection (%s) as a state, not an error', async (_name, rejection) => {
    tauri.speechModelStates
      .mockResolvedValueOnce([{ id: 'w', status: 'not-downloaded' }])
      .mockResolvedValue([{ id: 'w', status: 'paused', downloadedBytes: 10, totalBytes: 100 }])
    tauri.speechDownloadModel.mockRejectedValue(rejection)
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.download('w'))
    expect(result.current.statusOf('w').kind).toBe('paused')
  })

  it('surfaces other string rejections as errors', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    tauri.speechDownloadModel.mockRejectedValue('boom')
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.download('w'))
    expect(result.current.statusOf('w')).toEqual({
      kind: 'error',
      message: 'boom',
      action: 'download',
    })
  })

  it('reports verifying and unpacking phases from progress events', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    tauri.speechDownloadModel.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    act(() => void result.current.download('w'))
    act(() => emit(progress('unpacking')))
    expect(result.current.statusOf('w').kind).toBe('unpacking')
    expect(result.current.activeId).toBe('w')
  })

  it('leaves the active state on a paused progress event', async () => {
    tauri.speechModelStates.mockResolvedValue([
      { id: 'w', status: 'paused', downloadedBytes: 40, totalBytes: 100 },
    ])
    tauri.speechDownloadModel.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    act(() => void result.current.download('w'))
    expect(result.current.activeId).toBe('w')
    act(() => emit(progress('paused')))
    expect(result.current.activeId).toBeNull()
    await waitFor(() => expect(result.current.statusOf('w').kind).toBe('paused'))
  })

  it('cancel deletes partials and refreshes', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.cancel('w'))
    expect(tauri.speechCancelDownload).toHaveBeenCalledWith('w')
  })

  it('is not stuck when states still say downloading right after a paused event', async () => {
    tauri.speechModelStates
      .mockResolvedValueOnce([{ id: 'w', status: 'not-downloaded' }])
      .mockResolvedValueOnce([{ id: 'w', status: 'downloading' }])
      .mockResolvedValue([{ id: 'w', status: 'paused', downloadedBytes: 40, totalBytes: 100 }])
    tauri.speechDownloadModel.mockReturnValue(new Promise(() => undefined))
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    act(() => void result.current.download('w'))
    act(() => emit(progress('paused')))
    await waitFor(() => expect(result.current.statusOf('w').kind).toBe('paused'))
    expect(result.current.activeId).toBeNull()
  })

  it('follows a download reported by states and clears it when ready', async () => {
    tauri.speechModelStates
      .mockResolvedValueOnce([{ id: 'w', status: 'downloading' }])
      .mockResolvedValue([{ id: 'w', status: 'ready' }])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.activeId).toBe('w'))
    await waitFor(() => expect(result.current.activeId).toBeNull(), { timeout: 4000 })
    expect(result.current.statusOf('w').kind).toBe('ready')
  })

  it('ignores progress events for a model that is not active', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    act(() => emit({ ...progress('downloading'), modelId: 'other' }))
    expect(result.current.statusOf('w').kind).toBe('not-downloaded')
  })

  it('keeps the active download when another one is rejected as busy', async () => {
    tauri.speechListModels.mockResolvedValue([
      { id: 'a', label: 'A', kind: 'download', capability: 'stt', sizeBytes: 100 },
      { id: 'b', label: 'B', kind: 'download', capability: 'stt', sizeBytes: 100 },
    ])
    tauri.speechModelStates.mockResolvedValue([
      { id: 'a', status: 'not-downloaded' },
      { id: 'b', status: 'not-downloaded' },
    ])
    tauri.speechDownloadModel.mockImplementation((id: string) =>
      id === 'a' ? new Promise(() => undefined) : Promise.reject('speech_download_busy'),
    )
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(2))
    act(() => void result.current.download('a'))
    await act(() => result.current.download('b'))
    expect(result.current.activeId).toBe('a')
    expect(result.current.statusOf('a').kind).toBe('downloading')
    expect(result.current.statusOf('b')).toEqual({
      kind: 'error',
      message: 'speech_download_busy',
      action: 'download',
    })
  })

  it('surfaces a failed pause as a row error', async () => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'not-downloaded' }])
    tauri.speechPauseDownload.mockRejectedValue('nope')
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current.pause('w'))
    expect(result.current.statusOf('w')).toEqual({
      kind: 'error',
      message: 'nope',
      action: 'pause',
    })
  })

  it.each([
    ['remove', 'speechDeleteModel'],
    ['cancel', 'speechCancelDownload'],
  ] as const)('remembers that %s failed', async (action, command) => {
    tauri.speechModelStates.mockResolvedValue([{ id: 'w', status: 'ready' }])
    tauri[command].mockRejectedValue('locked')
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.models).toHaveLength(1))
    await act(() => result.current[action]('w'))
    expect(result.current.statusOf('w')).toEqual({ kind: 'error', message: 'locked', action })
  })

  it('reports a failed load and loads again on retry', async () => {
    tauri.speechModelStates.mockRejectedValueOnce('speech states failed')
    const { result } = renderHook(() => useModelDownloads())
    await waitFor(() => expect(result.current.loadFailed).toBe(true))
    expect(result.current.models).toEqual([])

    tauri.speechModelStates.mockResolvedValueOnce([{ id: 'w', status: 'ready' }])
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.loadFailed).toBe(false))
    expect(result.current.models).toHaveLength(1)
    expect(result.current.statusOf('w')).toEqual({ kind: 'ready' })
  })

  it('stops listening once and swallows a failed unlisten', async () => {
    tauri.speechModelStates.mockResolvedValue([])
    // A plain function: a vi.fn would itself observe the rejected promise it returns.
    let calls = 0
    const unlisten = () => {
      calls += 1
      return Promise.reject(
        new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')"),
      )
    }
    tauri.onSpeechDownloadProgress.mockResolvedValue(unlisten)
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const { result, unmount } = renderHook(() => useModelDownloads())
      await waitFor(() => expect(result.current.models).toHaveLength(1))
      unmount()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toBe(1)
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})
