import { Smartphone, Wifi, WifiOff } from 'lucide-react'

import { useRemoteControl } from '../../hooks/useRemoteControl'
import { useT } from '../../lib/i18n'
import { openRemoteControlPairing, remoteControlRevoke } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import { Modal } from './Modal'
import styles from './RemoteControlModal.module.css'

export function RemoteControlModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'remoteControl')
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const { busy, enabled, error, info, pairingOpen, run } = useRemoteControl(open)

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('remote.title')}
      width={620}
      footer={
        <>
          {enabled ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnDanger}`}
              onClick={() => setPreferences({ remoteEnabled: false })}
              disabled={busy}
            >
              <WifiOff size={14} />
              {t('remote.disable')}
            </button>
          ) : (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => setPreferences({ remoteEnabled: true })}
              disabled={busy}
            >
              <Wifi size={14} />
              {t('remote.enable')}
            </button>
          )}
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <div className={styles.hero}>
        <span className={`${styles.heroIcon} ${enabled ? styles.heroIconActive : ''}`}>
          <Smartphone size={21} />
        </span>
        <div>
          <h3>{enabled ? t('remote.enabled') : t('remote.disabled')}</h3>
          <p>{enabled ? t('remote.description') : t('remote.disabledDescription')}</p>
        </div>
        <span className={`${styles.status} ${enabled ? styles.statusOn : styles.statusOff}`}>
          <span className={styles.statusDot} />
          {enabled ? t('remote.statusOn') : t('remote.statusOff')}
        </span>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      {enabled ? (
        <div className={styles.contentGrid}>
          <section className={styles.qrCard}>
            {pairingOpen && info?.qr_svg ? (
              <>
                <img
                  className={styles.qr}
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qr_svg)}`}
                  alt={t('remote.qrAlt')}
                />
                <span className={styles.scanHint}>
                  {t('remote.pairingCountdown', { seconds: String(info.pairing_expires_in) })}
                </span>
              </>
            ) : (
              <>
                <span className={styles.scanHint}>{t('remote.pairingClosedHint')}</span>
                <button
                  type="button"
                  className={`${controls.btn} ${controls.btnPrimary}`}
                  onClick={() => void run(openRemoteControlPairing)}
                  disabled={busy}
                >
                  {t('remote.pairingOpenAction')}
                </button>
              </>
            )}
          </section>

          <section className={styles.details}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>{t('remote.connectedDevices')}</span>
              <strong>
                {info?.connected_devices ?? 0}/{info?.max_devices ?? 1}
              </strong>
              <span className={styles.metricHint}>
                {info?.connected_devices === 1
                  ? t('remote.deviceSingular')
                  : t('remote.devicePlural')}
              </span>
            </div>
            <button
              type="button"
              className={controls.btn}
              onClick={() => {
                closeModal()
                openModal('preferences', { category: 'remoteControl' })
              }}
            >
              {t('remote.openSettings')}
            </button>
            <div className={styles.urlBlock}>
              <span className={styles.metricLabel}>{t('remote.urlLabel')}</span>
              <code>
                {pairingOpen && info?.pairing_url
                  ? info.pairing_url
                  : t('remote.hiddenAddressPlaceholder')}
              </code>
            </div>
            <button
              type="button"
              className={controls.btn}
              onClick={() => void run(remoteControlRevoke)}
              disabled={busy}
            >
              {t('remote.revoke')}
            </button>
          </section>
        </div>
      ) : (
        <div className={styles.disabledCard}>
          <WifiOff size={18} />
          <p>{t('remote.disabledCard')}</p>
        </div>
      )}

      <p className={styles.hint}>{t('remote.hint')}</p>
      <p className={styles.securityNote}>{t('remote.securityNote')}</p>
    </Modal>
  )
}
