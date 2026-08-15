import { ShieldCheck, Smartphone, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  closeRemoteControlPairing,
  openRemoteControlPairing,
  remoteControlInfo,
  remoteControlRevoke,
  revokeRemoteControlDevice,
  type RemoteControlInfo,
} from '../../../lib/tauri'
import { useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import controls from '../controls.module.css'
import styles from './RemoteControlPage.module.css'
import { SettingsSection } from './primitives'
import { Dropdown } from '../../ui/Dropdown'

const SESSION_OPTIONS = [900, 3600, 86400]

function sessionLabel(t: ReturnType<typeof useT>, value: number) {
  if (value === 900) return t('remote.session900')
  if (value === 86400) return t('remote.session86400')
  return t('remote.session3600')
}

export function RemoteControlPage() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
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
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const update = async (operation: () => Promise<RemoteControlInfo>) => {
    setBusy(true)
    try {
      setInfo(await operation())
      setError(null)
    } catch (value) {
      setError(String(value))
    } finally {
      setBusy(false)
    }
  }

  const enabled = info?.enabled === true
  const pairingOpen = info?.pairing_open === true
  const readOnly = preferences.remoteReadOnly
  const allowShellInput = preferences.remoteAllowShellInput

  return (
    <>
      <SettingsSection
        id="remote-status"
        title={t('remote.settingsStatusTitle')}
        description={t('remote.settingsStatusDesc')}
      >
        <div className={styles.statusCard} data-enabled={enabled}>
          <span className={styles.statusIcon}>{enabled ? <Wifi size={18} /> : <WifiOff size={18} />}</span>
          <div>
            <strong>{enabled ? t('remote.statusOn') : t('remote.statusOff')}</strong>
            <p>{enabled ? (info?.connected_devices ? info.http_url : t('remote.hiddenAddressPlaceholder')) : t('remote.disabledDescription')}</p>
          </div>
          <button
            type="button"
            className={`${controls.btn} ${enabled ? controls.btnDanger : controls.btnPrimary}`}
            onClick={() => setPreferences({ remoteEnabled: !preferences.remoteEnabled })}
            disabled={busy}
          >
            {enabled ? t('remote.disable') : t('remote.enable')}
          </button>
        </div>
        <p className={styles.startupNote}>{t('remote.startupNote')}</p>
      </SettingsSection>

      {enabled ? (
        <SettingsSection
          id="remote-pairing"
          title={t('remote.pairingTitle')}
          description={t('remote.pairingDesc')}
        >
          <div className={styles.statusCard} data-enabled={pairingOpen}>
            <span className={styles.statusIcon}><Smartphone size={18} /></span>
            <div>
              <strong>{pairingOpen ? t('remote.pairingOpen') : t('remote.pairingClosed')}</strong>
              <p>
                {pairingOpen
                  ? t('remote.pairingCountdown', { seconds: String(info?.pairing_expires_in ?? 0) })
                  : t('remote.pairingClosedHint')}
              </p>
            </div>
            <button
              type="button"
              className={`${controls.btn} ${pairingOpen ? '' : controls.btnPrimary}`}
              onClick={() => void update(pairingOpen ? closeRemoteControlPairing : openRemoteControlPairing)}
              disabled={busy}
            >
              {pairingOpen ? t('remote.pairingClose') : t('remote.pairingOpenAction')}
            </button>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        id="remote-security"
        title={t('remote.settingsSecurityTitle')}
        description={t('remote.settingsSecurityDesc')}
      >
        <div className={styles.settingsGrid}>
          <label className={styles.setting}>
            <span>{t('remote.maxDevices')}</span>
            <Dropdown
              value={String(preferences.remoteMaxDevices)}
              onChange={(rawValue) => setPreferences({ remoteMaxDevices: Number(rawValue) })}
              disabled={busy}
              ariaLabel={t('remote.maxDevices')}
              options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: String(value) }))}
            />
          </label>
          <label className={styles.setting}>
            <span>{t('remote.sessionExpiry')}</span>
            <Dropdown
              value={String(preferences.remoteSessionExpirySecs)}
              onChange={(rawValue) => setPreferences({ remoteSessionExpirySecs: Number(rawValue) })}
              disabled={busy}
              ariaLabel={t('remote.sessionExpiry')}
              options={SESSION_OPTIONS.map((value) => ({ value: String(value), label: sessionLabel(t, value) }))}
            />
          </label>
          <label className={styles.setting}>
            <span>{t('remote.readOnly')}</span>
            <Dropdown
              value={readOnly ? 'on' : 'off'}
              onChange={(rawValue) => setPreferences({ remoteReadOnly: rawValue === 'on' })}
              disabled={busy}
              ariaLabel={t('remote.readOnly')}
              options={[
                { value: 'on', label: t('remote.readOnlyOn') },
                { value: 'off', label: t('remote.readOnlyOff') },
              ]}
            />
          </label>
          <label className={styles.setting}>
            <span>{t('remote.shellInput')}</span>
            <Dropdown
              value={allowShellInput ? 'on' : 'off'}
              onChange={(rawValue) => setPreferences({ remoteAllowShellInput: rawValue === 'on' })}
              disabled={busy || readOnly}
              ariaLabel={t('remote.shellInput')}
              options={[
                { value: 'off', label: t('remote.shellInputOff') },
                { value: 'on', label: t('remote.shellInputOn') },
              ]}
            />
          </label>
        </div>
        <div className={styles.securityNote}><ShieldCheck size={15} /><span>{t('remote.settingsSecurityNote')}</span></div>
      </SettingsSection>

      <SettingsSection
        id="remote-devices"
        title={t('remote.connectedDevices')}
        description={t('remote.settingsDevicesDesc')}
      >
        <div className={styles.deviceList}>
          {info?.devices.length ? info.devices.map((device) => (
            <div className={styles.device} key={device.id}>
              <span className={styles.deviceIcon}><Smartphone size={16} /></span>
              <div className={styles.deviceCopy}>
                <strong>{device.name}</strong>
                <span>
                  {device.address} · {device.online ? t('remote.deviceOnline') : t('remote.deviceOffline')} ·{' '}
                  {t('remote.deviceExpiresAt', { time: new Date(device.expires_at * 1000).toLocaleTimeString() })}
                </span>
              </div>
              <button type="button" className={`${controls.btn} ${controls.btnDanger}`} onClick={() => void update(() => revokeRemoteControlDevice(device.id))} disabled={busy}>
                {t('remote.revokeDevice')}
              </button>
            </div>
          )) : <p className={styles.empty}>{t('remote.noDevices')}</p>}
        </div>
        {info?.devices.length ? (
          <button type="button" className={`${controls.btn} ${controls.btnDanger}`} onClick={() => void update(remoteControlRevoke)} disabled={busy}>
            {t('remote.revokeAll')}
          </button>
        ) : null}
      </SettingsSection>

      {error ? <p className={styles.error}>{error}</p> : null}
    </>
  )
}
