import { Check, ChevronRight, UserRound } from 'lucide-react'
import { useEffect, useState } from 'react'

import { LOCALES, useT } from '../../../lib/i18n'
import {
  disconnectGoogleSync,
  getGoogleSyncStatus,
  type GoogleSyncUser,
  startGoogleSyncAuth,
} from '../../../lib/tauri'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
import { GoogleIcon } from '../../icons/AgentIcons'
import { ImageInput } from '../ImageInput'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
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
  const pushToast = useUiStore((state) => state.pushToast)

  const [googleUser, setGoogleUser] = useState<GoogleSyncUser>({
    email: '',
    name: '',
    connected: false,
  })
  const [loadingAuth, setLoadingAuth] = useState(false)

  useEffect(() => {
    getGoogleSyncStatus()
      .then(setGoogleUser)
      .catch(() => {})
  }, [])

  const handleConnectGoogle = async () => {
    setLoadingAuth(true)
    try {
      const user = await startGoogleSyncAuth()
      setGoogleUser(user)
      pushToast({ title: 'Google Conectado', body: `Autenticado com sucesso como ${user.email}` })
    } catch (e) {
      pushToast({ title: 'Erro de Conexão', body: String(e) })
    } finally {
      setLoadingAuth(false)
    }
  }

  const handleDisconnect = async () => {
    try {
      await disconnectGoogleSync()
      setGoogleUser({ email: '', name: '', connected: false })
      pushToast({ title: 'Desconectado', body: 'Conta Google desvinculada. Modo Local ativo.' })
    } catch (e) {
      pushToast({ title: 'Erro', body: String(e) })
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
        title={t('prefs.googleSyncTitle') || 'Sincronização com Conta Google & Email'}
        description={
          t('prefs.googleSyncDesc') ||
          'Conecte seu email ou Google para sincronizar projetos entre seus computadores e receber convites.'
        }
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
                  {googleUser.connected ? googleUser.name : 'Alethe Cloud · Conta Google'}
                </strong>
                <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                  {googleUser.connected
                    ? `${googleUser.email} · Sincronização Online`
                    : 'Não conectado · Sincronização Local (Mesh P2P)'}
                </span>
              </div>
            </div>
            {googleUser.connected ? (
              <button
                type="button"
                style={{
                  background: 'transparent',
                  color: 'var(--status-error)',
                  fontWeight: 600,
                  fontSize: '11px',
                  padding: '6px 12px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                }}
                onClick={handleDisconnect}
              >
                Desconectar
              </button>
            ) : (
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
                  cursor: 'pointer',
                  boxShadow: 'var(--shadow-xs)',
                }}
                disabled={loadingAuth}
                onClick={handleConnectGoogle}
              >
                <GoogleIcon size={15} />
                <span>{loadingAuth ? 'Conectando...' : 'Conectar com Google'}</span>
              </button>
            )}
          </div>
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
