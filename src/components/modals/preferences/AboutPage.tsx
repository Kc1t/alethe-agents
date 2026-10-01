import { getVersion } from '@tauri-apps/api/app'
import { DownloadCloud, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../../lib/i18n'
import { checkForUpdate, installPendingUpdate } from '../../../lib/updater'
import { useUiStore } from '../../../stores/uiStore'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

export function AboutPage() {
  const t = useT()
  const updateInfo = useUiStore((state) => state.updateInfo)
  const setUpdateInfo = useUiStore((state) => state.setUpdateInfo)
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkedUpToDate, setCheckedUpToDate] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(''))
  }, [])

  const onCheck = async () => {
    if (checking) return
    setChecking(true)
    setCheckedUpToDate(false)
    setError('')
    try {
      const info = await checkForUpdate()
      setUpdateInfo(info)
      if (!info) setCheckedUpToDate(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setChecking(false)
    }
  }

  const onInstall = async () => {
    setPhase('installing')
    setError('')
    try {
      await installPendingUpdate(({ downloaded, total }) => {
        setPercent(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0)
      })
    } catch (err) {
      setPhase('error')
      setError(String(err))
    }
  }

  const installing = phase === 'installing'

  return (
    <>
      <SettingsSection
        id="app-version"
        title={t('prefs.aboutVersionTitle')}
        description={t('prefs.aboutVersionDesc')}
      >
        <div className={styles.versionCard}>
          <div className={styles.versionCardCopy}>
            <strong>Alethe</strong>
            <span>com.kc1t.alethe</span>
          </div>
          <span className={styles.versionCardNumber}>{version ? `v${version}` : '—'}</span>
        </div>
      </SettingsSection>

      <SettingsSection
        id="app-updates"
        title={t('prefs.aboutUpdatesTitle')}
        description={t('prefs.aboutUpdatesDesc')}
      >
        {updateInfo ? (
          <div className={styles.updateBlock}>
            <div className={styles.updateAvailable}>
              <DownloadCloud size={16} />
              <span>
                {t('prefs.aboutUpdateAvailable', {
                  version: updateInfo.version,
                  current: updateInfo.currentVersion,
                })}
              </span>
            </div>
            {updateInfo.notes ? <div className={styles.updateNotes}>{updateInfo.notes}</div> : null}
            {installing ? (
              <div className={styles.updateProgress} aria-hidden>
                <div className={styles.updateProgressBar} style={{ width: `${percent}%` }} />
              </div>
            ) : null}
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary} ${styles.alignStart}`}
              onClick={() => void onInstall()}
              disabled={installing}
            >
              {installing ? t('update.installing', { percent }) : t('update.installNow')}
            </button>
          </div>
        ) : (
          <div className={styles.updateBlock}>
            <button
              type="button"
              className={`${styles.secondaryButton} ${styles.alignStart}`}
              onClick={() => void onCheck()}
              disabled={checking}
            >
              <RotateCcw size={15} />
              {checking ? t('prefs.aboutChecking') : t('prefs.aboutCheckUpdates')}
            </button>
            {checkedUpToDate ? (
              <span className={styles.updateCheckedNote}>
                {t('prefs.aboutUpToDate', { version })}
              </span>
            ) : null}
          </div>
        )}
        {error ? <p className={styles.updateError}>{t('update.error', { error })}</p> : null}
      </SettingsSection>
    </>
  )
}
