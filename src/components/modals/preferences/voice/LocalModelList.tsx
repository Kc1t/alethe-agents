import { useEffect, useRef, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { type DownloadRate, nextRate } from '../../../../lib/speech/downloadStats'
import {
  onSpeechDownloadProgress,
  speechDeleteModel,
  speechDownloadModel,
  type SpeechDownloadProgress,
} from '../../../../lib/tauri'
import controls from '../../controls.module.css'
import { ModelDownloadProgress } from '../ModelDownloadProgress'
import styles from './LocalModelList.module.css'
import { useSpeechInventory } from './useSpeechInventory'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function LocalModelList({ capability }: { capability: 'stt' | 'tts' | 'all' }) {
  const t = useT()
  const { models, states, refresh } = useSpeechInventory()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [download, setDownload] = useState<SpeechDownloadProgress | null>(null)
  const [bytesPerSecond, setBytesPerSecond] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rateRef = useRef<DownloadRate | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void onSpeechDownloadProgress((progress) => {
      setDownload(progress)
      if (progress.phase === 'downloading') {
        rateRef.current = nextRate(rateRef.current, {
          bytes: progress.downloaded,
          at: performance.now(),
        })
        setBytesPerSecond(rateRef.current.bytesPerSecond)
      }
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    rateRef.current = null
    setBytesPerSecond(null)
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
      setDownload(null)
    }
  }

  const rows = models.filter(
    (model) =>
      model.kind === 'download' &&
      (capability === 'all' || (model.capability ?? 'stt') === capability),
  )

  return (
    <div className={styles.root}>
      <ul className={styles.list}>
        {rows.map((model) => {
          const ready = states[model.id]?.status === 'ready'
          return (
            <li key={model.id} className={styles.row} aria-label={model.label}>
              <div className={styles.info}>
                <strong>{model.label}</strong>
                <small>
                  {t(
                    model.capability === 'tts'
                      ? 'prefs.voiceModelKindTts'
                      : 'prefs.voiceModelKindStt',
                  )}
                  {' · '}
                  {formatBytes(model.sizeBytes)}
                  {' · '}
                  {t(ready ? 'prefs.voiceModelReady' : 'prefs.voiceModelNotDownloaded')}
                </small>
                {download?.modelId === model.id ? (
                  <ModelDownloadProgress progress={download} bytesPerSecond={bytesPerSecond} />
                ) : null}
              </div>
              {ready ? (
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnSmDanger}`}
                  disabled={busyId !== null}
                  onClick={() => void run(model.id, () => speechDeleteModel(model.id))}
                >
                  {t('prefs.dictationModelDelete')}
                </button>
              ) : (
                <button
                  type="button"
                  className={controls.btn}
                  disabled={busyId !== null}
                  onClick={() => void run(model.id, () => speechDownloadModel(model.id, null))}
                >
                  {t('prefs.dictationModelDownload')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  )
}
