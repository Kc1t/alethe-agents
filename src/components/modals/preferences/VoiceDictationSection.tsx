import { useCallback, useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { formatShortcut } from '../../../lib/platform'
import { DEFAULT_SPEECH_MODEL_ID } from '../../../lib/speech/audio'
import {
  onSpeechDownloadProgress,
  speechDeleteModel,
  speechDownloadModel,
  speechListInputDevices,
  speechListModels,
  speechModelStates,
  type SpeechInputDevice,
  type SpeechModelManifest,
  type SpeechModelState,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function VoiceDictationSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const shortcut = formatShortcut('Ctrl+E')

  const [models, setModels] = useState<SpeechModelManifest[]>([])
  const [states, setStates] = useState<Record<string, SpeechModelState>>({})
  const [mics, setMics] = useState<SpeechInputDevice[]>([])
  const [downloadFraction, setDownloadFraction] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStates = useCallback(async () => {
    const next = await speechModelStates()
    const map: Record<string, SpeechModelState> = {}
    for (const state of next) map[state.id] = state
    setStates(map)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [catalog, devices] = await Promise.all([
          speechListModels(),
          speechListInputDevices().catch(() => [] as SpeechInputDevice[]),
        ])
        if (cancelled) return
        setModels(catalog)
        setMics(devices)
        await refreshStates()
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshStates])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onSpeechDownloadProgress((progress) => {
      if (progress.modelId === (preferences.dictationModelId || DEFAULT_SPEECH_MODEL_ID)) {
        setDownloadFraction(progress.fraction)
      }
    }).then((fn) => {
      unlisten = fn
    })
    return () => {
      unlisten?.()
    }
  }, [preferences.dictationModelId])

  const modelId = preferences.dictationModelId || DEFAULT_SPEECH_MODEL_ID
  const model = models.find((item) => item.id === modelId) ?? models[0]
  const modelState = states[modelId]

  const enableDictation = async () => {
    setError(null)
    try {
      await speechListInputDevices()
      setPreferences({ dictationEnabled: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const downloadModel = async () => {
    if (!model) return
    setBusy(true)
    setError(null)
    setDownloadFraction(0)
    try {
      await speechDownloadModel(model.id)
      setPreferences({ dictationModelId: model.id })
      await refreshStates()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      setDownloadFraction(null)
    }
  }

  const deleteModel = async () => {
    if (!model) return
    setBusy(true)
    setError(null)
    try {
      await speechDeleteModel(model.id)
      await refreshStates()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsSection
        id="dictation"
        title={t('prefs.dictation')}
        description={t('prefs.dictationDesc', { shortcut })}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => void enableDictation()}
          >
            {t('prefs.dictationOn')}
          </button>
          <button
            type="button"
            className={!preferences.dictationEnabled ? styles.segmentActive : undefined}
            onClick={() => setPreferences({ dictationEnabled: false })}
          >
            {t('prefs.dictationOff')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="dictation-mode"
        title={t('prefs.dictationMode')}
        description={t('prefs.dictationModeDesc', { shortcut })}
      >
        <div className={styles.segmented}>
          <button
            type="button"
            className={preferences.dictationMode === 'toggle' ? styles.segmentActive : undefined}
            disabled={!preferences.dictationEnabled}
            onClick={() => setPreferences({ dictationMode: 'toggle' })}
          >
            {t('prefs.dictationModeToggle')}
          </button>
          <button
            type="button"
            className={preferences.dictationMode === 'hold' ? styles.segmentActive : undefined}
            disabled={!preferences.dictationEnabled}
            onClick={() => setPreferences({ dictationMode: 'hold' })}
          >
            {t('prefs.dictationModeHold')}
          </button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="dictation-mic"
        title={t('prefs.dictationMic')}
        description={t('prefs.dictationMicDesc')}
      >
        <select
          className={styles.select}
          disabled={!preferences.dictationEnabled}
          value={preferences.dictationMicrophoneId ?? ''}
          onChange={(event) => {
            const value = event.target.value
            if (!value) {
              setPreferences({ dictationMicrophoneId: null, dictationMicrophoneLabel: null })
              return
            }
            const device = mics.find((item) => item.deviceId === value)
            setPreferences({
              dictationMicrophoneId: value,
              dictationMicrophoneLabel: device?.label ?? null,
            })
          }}
          aria-label={t('prefs.dictationMic')}
        >
          <option value="">{t('prefs.dictationMicSystem')}</option>
          {mics.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
              {device.isDefault ? ` (${t('prefs.dictationMicSystem')})` : ''}
            </option>
          ))}
        </select>
      </SettingsSection>

      <SettingsSection
        id="dictation-model"
        title={t('prefs.dictationModel')}
        description={model?.description ?? t('prefs.dictationModelDesc')}
      >
        {model ? (
          <div className={styles.integrationFields}>
            <p>
              <strong>{model.label}</strong>
              {model.recommended ? ` · ${t('prefs.dictationModelRecommended')}` : null}
              {` · ${formatBytes(model.sizeBytes)}`}
            </p>
            <p>
              {modelState?.status === 'ready'
                ? t('prefs.dictationModelReady')
                : t('prefs.dictationModelMissing')}
            </p>
            {downloadFraction != null ? (
              <p>
                {t('prefs.dictationModelProgress', { percent: Math.round(downloadFraction * 100) })}
              </p>
            ) : null}
            <div className={styles.segmented}>
              <button
                type="button"
                disabled={busy || modelState?.status === 'ready'}
                onClick={() => void downloadModel()}
              >
                {t('prefs.dictationModelDownload')}
              </button>
              <button
                type="button"
                disabled={busy || modelState?.status !== 'ready'}
                onClick={() => void deleteModel()}
              >
                {t('prefs.dictationModelDelete')}
              </button>
            </div>
          </div>
        ) : (
          <p>{t('prefs.dictationModelLoading')}</p>
        )}
        {error ? (
          <div className={styles.integrationFields}>
            <p className={styles.cliWarning}>{error}</p>
          </div>
        ) : null}
      </SettingsSection>
    </>
  )
}
