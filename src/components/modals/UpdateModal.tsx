import { useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../lib/i18n'
import { installPendingUpdate } from '../../lib/updater'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './UpdateModal.module.css'

export function UpdateModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'updateAvailable')
  const info = useUiStore((s) => s.updateInfo)
  const closeModal = useUiStore((s) => s.closeModal)
  const [phase, setPhase] = useState<'idle' | 'installing' | 'error'>('idle')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')

  if (!open || !info) return null

  const installing = phase === 'installing'

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

  return (
    <Modal
      open={open}

      onClose={installing ? () => {} : closeModal}
      title={t('update.availableTitle', { version: info.version })}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal} disabled={installing}>
            {t('update.later')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void onInstall()}
            disabled={installing}
          >
            {installing ? t('update.installing', { percent }) : t('update.installNow')}
          </button>
        </>
      }
    >
      <p className={styles.summary}>
        {t('update.body', { current: info.currentVersion, version: info.version })}
      </p>
      {info.notes ? <div className={styles.notes}>{info.notes}</div> : null}
      {installing ? (
        <div className={styles.progressTrack} aria-hidden>
          <div className={styles.progressBar} style={{ transform: `scaleX(${percent / 100})` }} />
        </div>
      ) : null}
      {phase === 'error' ? <p className={styles.error}>{t('update.error', { error })}</p> : null}
    </Modal>
  )
}
