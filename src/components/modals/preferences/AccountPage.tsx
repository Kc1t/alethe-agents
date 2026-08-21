import { Check, ChevronRight, Loader2, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import { LOCALES, useT } from '../../../lib/i18n'
import {
  configureGoogleSync,
  getGoogleSyncStatus,
  type GoogleSyncUser,
  startGoogleSyncAuth,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { GoogleIcon } from '../../icons/AgentIcons'
import controls from '../controls.module.css'
import { ImageInput } from '../ImageInput'
import styles from '../PreferencesModal.module.css'
import { CollaborationSettings } from './CollaborationSettings'
import { Avatar, SettingsSection } from './primitives'

export function AccountPage({
  avatarUrl,
  initial,
  onManageAccounts,
}: {
  avatarUrl: string | null
  initial: string
  onManageAccounts: () => void
}) {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setLanguage = useProjectsStore((state) => state.setLanguage)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const [google, setGoogle] = useState<GoogleSyncUser | null>(null)
  const [googleBusy, setGoogleBusy] = useState(false)
  const [googleError, setGoogleError] = useState(false)
  const [showGoogleSetup, setShowGoogleSetup] = useState(false)
  const [googleClientId, setGoogleClientId] = useState('')

  useEffect(() => {
    let active = true
    void getGoogleSyncStatus()
      .then((status) => {
        if (active) setGoogle(status)
      })
      .catch(() => {
        if (active) setGoogleError(true)
      })
    return () => {
      active = false
    }
  }, [])

  const runGoogleLogin = async () => {
    setGoogleBusy(true)
    setGoogleError(false)
    try {
      setGoogle(await startGoogleSyncAuth())
    } catch {
      setGoogleError(true)
    } finally {
      setGoogleBusy(false)
    }
  }

  const saveGoogleConfiguration = async () => {
    setGoogleBusy(true)
    setGoogleError(false)
    try {
      await configureGoogleSync(googleClientId)
      setGoogle(await getGoogleSyncStatus())
      setShowGoogleSetup(false)
      setGoogleClientId('')
    } catch {
      setGoogleError(true)
    } finally {
      setGoogleBusy(false)
    }
  }

  return (
    <>
      <SettingsSection id="profile" title={t('prefs.profile')} description={t('prefs.profileDesc')}>
        <div className={styles.profileEditor}>
          <Avatar url={avatarUrl} initial={initial} large />
          <div className={styles.profileFields}>
            <label>
              <span>{t('prefs.displayName')}</span>
              <input
                className={controls.input}
                value={preferences.displayName}
                onChange={(event) => setPreferences({ displayName: event.target.value })}
                placeholder={t('prefs.namePlaceholder')}
                maxLength={60}
              />
            </label>
            <ImageInput
              label={t('prefs.profilePhoto')}
              value={preferences.profileImageUrl}
              onChange={(profileImageUrl) => setPreferences({ profileImageUrl })}
              placeholder={t('prefs.photoPlaceholder')}
              hint={t('image.urlOrUpload')}
            />
          </div>
        </div>
      </SettingsSection>

      <CollaborationSettings />

      <SettingsSection
        id="language"
        title={t('prefs.language')}
        description={t('prefs.languageDesc')}
      >
        <div className={styles.choiceGrid}>
          {LOCALES.map((locale) => (
            <button
              key={locale.id}
              type="button"
              className={preferences.language === locale.id ? styles.choiceActive : undefined}
              onClick={() => setLanguage(locale.id)}
            >
              <span>{locale.nativeName}</span>
              {preferences.language === locale.id ? <Check size={16} /> : null}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        id="google-sync"
        title={t('prefs.googleSyncTitle')}
        description={t('prefs.googleSyncDesc')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '32px',
                  height: '32px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                }}
              >
                <GoogleIcon size={18} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <strong style={{ fontSize: '13px', color: 'var(--fg)' }}>
                  {t('prefs.googleSyncProvider')}
                </strong>
                <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                  {googleError
                    ? t('mesh.oauthFailed')
                    : google?.connected
                      ? t('mesh.connectedAccount', { name: google.name })
                      : google?.configured
                        ? t('prefs.googleSyncReadyStatus')
                        : t('mesh.oauthNotConfigured')}
                </span>
              </div>
            </div>
            <button
              type="button"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                background: 'var(--bg)',
                color: 'var(--fg)',
                fontWeight: 600,
                fontSize: '12px',
                padding: '7px 14px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                cursor: googleBusy || google?.connected ? 'default' : 'pointer',
                boxShadow: 'var(--shadow-xs)',
              }}
              disabled={googleBusy || google?.connected}
              onClick={() => {
                if (google?.configured) void runGoogleLogin()
                else setShowGoogleSetup((visible) => !visible)
              }}
            >
              {googleBusy ? <Loader2 size={15} /> : <GoogleIcon size={15} />}
              <span>
                {googleBusy
                  ? t('mesh.authenticating')
                  : google?.configured
                    ? t('mesh.connectAccount')
                    : t('mesh.configureGoogle')}
              </span>
            </button>
          </div>
          {showGoogleSetup && !google?.configured ? (
            <div className={styles.integrationFields}>
              <label>
                <span>{t('mesh.googleClientId')}</span>
                <input
                  className={controls.input}
                  value={googleClientId}
                  placeholder="000000000000-example.apps.googleusercontent.com"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => setGoogleClientId(event.target.value)}
                />
              </label>
              <p>{t('mesh.googleClientIdHint')}</p>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                disabled={googleBusy || !googleClientId.trim()}
                onClick={() => void saveGoogleConfiguration()}
              >
                {t('mesh.saveConfiguration')}
              </button>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection
        id="local-accounts"
        title={t('prefs.localAccounts')}
        description={t('prefs.localAccountsDesc')}
      >
        <button type="button" className={styles.secondaryButton} onClick={onManageAccounts}>
          <UserRound size={15} />
          {t('profile.manageAccounts')}
          <ChevronRight size={15} />
        </button>
      </SettingsSection>
    </>
  )
}
