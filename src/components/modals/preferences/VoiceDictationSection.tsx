import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { formatShortcut } from '../../../lib/platform'
import { type SpeechInputDevice, speechListInputDevices } from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

export function VoiceDictationSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const shortcut = formatShortcut('Ctrl+E')

  const [mics, setMics] = useState<SpeechInputDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void speechListInputDevices()
      .then((devices) => {
        if (!cancelled) setMics(devices)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const enableDictation = async () => {
    setError(null)
    try {
      await speechListInputDevices()
      setPreferences({ dictationEnabled: true })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
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
        <Dropdown
          rootClassName={styles.dictationMicSelect}
          disabled={!preferences.dictationEnabled}
          value={preferences.dictationMicrophoneId ?? ''}
          onChange={(value) => {
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
          ariaLabel={t('prefs.dictationMic')}
          options={[
            { value: '', label: t('prefs.dictationMicSystem') },
            ...mics.map((device) => ({
              value: device.deviceId,
              label: `${device.label}${device.isDefault ? ` (${t('prefs.dictationMicSystem')})` : ''}`,
            })),
          ]}
        />
      </SettingsSection>
      {error ? <p className={styles.cliWarning}>{error}</p> : null}
    </>
  )
}
