import { Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { writeClipboardText, type RemoteControlInfo, type TailscaleStatus } from '../../lib/tauri'
import type { useT } from '../../lib/i18n'
import type { Preferences } from '../../lib/types'
import { Dropdown } from '../ui/Dropdown'
import styles from './RemoteControlSettingsFields.module.css'

export const SESSION_OPTIONS = [900, 3600, 86400]

export function sessionLabel(t: ReturnType<typeof useT>, value: number) {
  if (value === 900) return t('remote.session900')
  if (value === 86400) return t('remote.session86400')
  return t('remote.session3600')
}

type RemoteControlSettingsFieldsProps = {
  t: ReturnType<typeof useT>
  preferences: Preferences
  setPreferences: (partial: Partial<Preferences>) => void
  info: RemoteControlInfo | null
  tailscale: TailscaleStatus | null
  busy: boolean
  reachHeading?: ReactNode
  parts?: Array<'reach' | 'security'>
}

export function RemoteControlSettingsFields({
  t,
  preferences,
  setPreferences,
  info,
  tailscale,
  busy,
  reachHeading,
  parts = ['reach', 'security'],
}: RemoteControlSettingsFieldsProps) {
  const readOnly = preferences.remoteReadOnly
  const allowShellInput = preferences.remoteAllowShellInput
  const showReach = parts.includes('reach')
  const showSecurity = parts.includes('security')
  const [linkCopied, setLinkCopied] = useState(false)

  const copyDownloadLink = async () => {
    try {
      await writeClipboardText(t('remote.reachTailscaleDownloadUrl'))
      setLinkCopied(true)
      window.setTimeout(() => setLinkCopied(false), 2000)
    } catch {
      // Clipboard access can be denied by the OS; the URL is still visible as text.
    }
  }

  return (
    <div className={styles.root}>
      {showReach ? (
        <div className={styles.block}>
          {reachHeading}
          <label className={styles.setting}>
            <span>{t('remote.reachTitle')}</span>
            <Dropdown
              value={preferences.remoteUseTailscale ? 'tailscale' : 'lan'}
              onChange={(rawValue) => setPreferences({ remoteUseTailscale: rawValue === 'tailscale' })}
              disabled={busy}
              ariaLabel={t('remote.reachTitle')}
              options={[
                { value: 'lan', label: t('remote.reachLan') },
                {
                  value: 'tailscale',
                  label: t('remote.reachTailscale'),
                  disabled: tailscale?.available !== true,
                },
              ]}
            />
          </label>
          <p className={styles.hint}>
            {tailscale?.available ? t('remote.reachTailscaleHint') : t('remote.reachTailscaleUnavailable')}
          </p>
          {!tailscale?.available ? (
            <div className={styles.downloadRow}>
              <code>{t('remote.reachTailscaleDownloadUrl')}</code>
              <button type="button" className={styles.copyButton} onClick={() => void copyDownloadLink()}>
                {linkCopied ? <Check size={13} /> : <Copy size={13} />}
                {linkCopied ? t('remote.reachTailscaleLinkCopied') : t('remote.reachTailscaleCopyLink')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {showSecurity ? (
      <>
      <div className={styles.block}>
        <label className={styles.settingRow}>
          <span className={styles.settingCopy}>
            <span className={styles.settingLabel}>{t('remote.maxDevices')}</span>
            <span className={styles.settingCaption}>{t('remote.maxDevicesHint')}</span>
          </span>
          <Dropdown
            value={String(preferences.remoteMaxDevices)}
            onChange={(rawValue) => setPreferences({ remoteMaxDevices: Number(rawValue) })}
            disabled={busy}
            ariaLabel={t('remote.maxDevices')}
            options={[1, 2, 3, 4].map((value) => ({ value: String(value), label: String(value) }))}
          />
        </label>
        <label className={styles.settingRow}>
          <span className={styles.settingCopy}>
            <span className={styles.settingLabel}>{t('remote.sessionExpiry')}</span>
            <span className={styles.settingCaption}>{t('remote.sessionExpiryHint')}</span>
          </span>
          <Dropdown
            value={String(preferences.remoteSessionExpirySecs)}
            onChange={(rawValue) => setPreferences({ remoteSessionExpirySecs: Number(rawValue) })}
            disabled={busy}
            ariaLabel={t('remote.sessionExpiry')}
            options={SESSION_OPTIONS.map((value) => ({ value: String(value), label: sessionLabel(t, value) }))}
          />
        </label>
        <label className={styles.settingRow}>
          <span className={styles.settingCopy}>
            <span className={styles.settingLabel}>{t('remote.readOnly')}</span>
            <span className={styles.settingCaption}>{t('remote.readOnlyHint')}</span>
          </span>
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
        <label className={styles.settingRow}>
          <span className={styles.settingCopy}>
            <span className={styles.settingLabel}>{t('remote.shellInput')}</span>
            <span className={styles.settingCaption}>{t('remote.shellInputHint')}</span>
          </span>
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

      <p className={styles.securityNote}>
        {t(info?.reach_mode === 'tailscale' ? 'remote.settingsSecurityNoteTailscale' : 'remote.settingsSecurityNote')}
      </p>
      </>
      ) : null}
    </div>
  )
}
