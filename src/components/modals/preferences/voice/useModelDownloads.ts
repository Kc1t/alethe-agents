import { useCallback, useEffect, useRef, useState } from 'react'

import { type DownloadRate, nextRate } from '../../../../lib/speech/downloadStats'
import {
  DOWNLOAD_PAUSED,
  listenerCleanup,
  onSpeechDownloadProgress,
  speechCancelDownload,
  speechDeleteModel,
  speechDownloadModel,
  type SpeechDownloadProgress,
  speechListModels,
  type SpeechModelManifest,
  type SpeechModelState,
  speechModelStates,
  speechPauseDownload,
} from '../../../../lib/tauri'
import { rememberHubModels } from '../../../../lib/voice/modelInfo'

export type FailedAction = 'download' | 'pause' | 'remove' | 'cancel'

type RowError = { message: string; action: FailedAction }

export type RowStatus =
  | { kind: 'not-downloaded' }
  | { kind: 'downloading'; progress: SpeechDownloadProgress | null; bytesPerSecond: number | null }
  | { kind: 'verifying' }
  | { kind: 'unpacking' }
  | { kind: 'paused'; downloaded: number; total: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; action: FailedAction }

function fromState(state: SpeechModelState | undefined, size: number): RowStatus {
  switch (state?.status) {
    case 'ready':
      return { kind: 'ready' }
    case 'paused':
      return {
        kind: 'paused',
        downloaded: state.downloadedBytes ?? 0,
        total: state.totalBytes ?? size,
      }
    case 'error':
      return { kind: 'error', message: state.error ?? '', action: 'download' }
    case 'downloading':
      return { kind: 'downloading', progress: null, bytesPerSecond: null }
    default:
      return { kind: 'not-downloaded' }
  }
}

function rejectionMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

const PAUSE_SETTLE_MS = 400

const EXTERNAL_POLL_MS = 2000

export function useModelDownloads() {
  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})
  const [localActiveId, setLocalActiveId] = useState<string | null>(null)
  const [progress, setProgress] = useState<SpeechDownloadProgress | null>(null)
  const [bytesPerSecond, setBytesPerSecond] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<string, RowError | null>>({})
  const [loadFailed, setLoadFailed] = useState(false)
  const rateRef = useRef<DownloadRate | null>(null)

  const reportedId = Object.values(states).find((state) => state.status === 'downloading')?.id
  const activeId = localActiveId ?? reportedId ?? null
  const activeRef = useRef<string | null>(activeId)
  activeRef.current = activeId

  const refresh = useCallback(async () => {
    let catalog: SpeechModelManifest[]
    let list: SpeechModelState[]
    try {
      ;[catalog, list] = await Promise.all([speechListModels(), speechModelStates()])
    } catch (cause) {
      setLoadFailed(true)
      throw cause
    }
    setLoadFailed(false)
    rememberHubModels(catalog)
    setModels(catalog)
    setStates(Object.fromEntries(list.map((state) => [state.id, state])))
  }, [])

  const retry = useCallback(() => void refresh().catch(() => undefined), [refresh])

  useEffect(() => {
    void refresh().catch(() => undefined)
  }, [refresh])

  const externalId = localActiveId === null ? (reportedId ?? null) : null
  useEffect(() => {
    if (externalId === null) return
    const timer = setInterval(() => void refresh().catch(() => undefined), EXTERNAL_POLL_MS)
    return () => clearInterval(timer)
  }, [externalId, refresh])

  const resetLive = () => {
    setProgress(null)
    rateRef.current = null
    setBytesPerSecond(null)
  }

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const stopListening = listenerCleanup(
      onSpeechDownloadProgress((next) => {
        if (next.phase === 'paused') {
          setLocalActiveId((current) => (current === next.modelId ? null : current))
          if (activeRef.current === next.modelId) resetLive()
          void refresh().catch(() => undefined)
          clearTimeout(settleTimer)
          settleTimer = setTimeout(() => void refresh().catch(() => undefined), PAUSE_SETTLE_MS)
          return
        }
        if (activeRef.current !== next.modelId) return
        setProgress(next)
        if (next.phase === 'downloading') {
          rateRef.current = nextRate(rateRef.current, {
            bytes: next.downloaded,
            at: performance.now(),
          })
          setBytesPerSecond(rateRef.current.bytesPerSecond)
        }
      }),
      () => setLoadFailed(true),
    )
    return () => {
      clearTimeout(settleTimer)
      stopListening()
    }
  }, [refresh])

  const settle = async (id: string, action: FailedAction, work: () => Promise<unknown>) => {
    setErrors((all) => ({ ...all, [id]: null }))
    try {
      await work()
    } catch (cause) {
      const message = rejectionMessage(cause)
      if (message !== DOWNLOAD_PAUSED) setErrors((all) => ({ ...all, [id]: { message, action } }))
    } finally {
      setLocalActiveId((current) => (current === id ? null : current))
      if (activeRef.current === null || activeRef.current === id) resetLive()
      await refresh().catch(() => undefined)
    }
  }

  const statusOf = (id: string): RowStatus => {
    const error = errors[id]
    if (error) return { kind: 'error', ...error }
    if (activeId === id) {
      if (progress?.modelId === id && progress.phase === 'verifying') return { kind: 'verifying' }
      if (progress?.modelId === id && progress.phase === 'unpacking') return { kind: 'unpacking' }
      return {
        kind: 'downloading',
        progress: progress?.modelId === id ? progress : null,
        bytesPerSecond,
      }
    }
    const model = models.find((entry) => entry.id === id)
    return fromState(states[id], model?.sizeBytes ?? 0)
  }

  return {
    models,
    refresh,

    loadFailed,
    retry,
    activeId,
    statusOf,
    download: (id: string) => {
      if (activeRef.current === null) setLocalActiveId(id)
      return settle(id, 'download', () => speechDownloadModel(id, null))
    },
    pause: async (id: string) => {
      try {
        await speechPauseDownload(id)
      } catch (cause) {
        setErrors((all) => ({
          ...all,
          [id]: { message: rejectionMessage(cause), action: 'pause' },
        }))
      }
    },
    cancel: (id: string) => settle(id, 'cancel', () => speechCancelDownload(id)),
    remove: (id: string) => settle(id, 'remove', () => speechDeleteModel(id)),
  }
}
