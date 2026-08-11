import { Smartphone, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  remoteControlInfo,
  remoteControlRevoke,
  setRemoteControlEnabled,
  type RemoteControlInfo,
} from '../../lib/tauri'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './RemoteControlModal.module.css'

export function RemoteControlModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'remoteControl')
  const closeModal = useUiStore((state) => state.closeModal)
  const openModal = useUiStore((state) => state.openModal_)
  const [info, setInfo] = useState<RemoteControlInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setInfo(await remoteControlInfo())
      setError(null)
    } catch (value) {
      setError(String(value))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)
    try {
      setInfo(await setRemoteControlEnabled(enabled))
      setError(null)
    } catch (value) {
      setError(String(value))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    setBusy(true)
    try {
      setInfo(await remoteControlRevoke())
      setError(null)
    } catch (value) {
      setError(String(value))
    } finally {
      setBusy(false)
    }
  }

  const enabled = info?.enabled === true

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
              onClick={() => void setEnabled(false)}
              disabled={busy}
            >
              <WifiOff size={14} />
              {t('remote.disable')}
            </button>
          ) : (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={() => void setEnabled(true)}
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

      {enabled && info?.pairing_url ? (
        <div className={styles.contentGrid}>
          <section className={styles.qrCard}>
            {info.qr_svg ? (
              <img
                className={styles.qr}
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qr_svg)}`}
                alt={t('remote.qrAlt')}
              />
            ) : null}
            <span className={styles.scanHint}>{t('remote.scanHint')}</span>
          </section>

          <section className={styles.details}>
            <div className={styles.metric}>
              <span className={styles.metricLabel}>{t('remote.connectedDevices')}</span>
              <strong>
                {info.connected_devices}/{info.max_devices}
              </strong>
              <span className={styles.metricHint}>
                {info.connected_devices === 1
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
                {info.connected_devices > 0
                  ? info.pairing_url
                  : t('remote.hiddenAddressPlaceholder')}
              </code>
            </div>
            <button
              type="button"
              className={controls.btn}
              onClick={() => void revoke()}
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
