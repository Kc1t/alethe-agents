import { Check, ChevronRight, Globe, UserRound } from 'lucide-react'

import { LOCALES, useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
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
              padding: '10px 12px',
              background: 'var(--bg-sunken)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Globe size={18} style={{ color: 'var(--accent)' }} />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <strong style={{ fontSize: '12px' }}>Alethe Cloud / Google Identity</strong>
                <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                  Não conectado · Sincronização Local ativa
                </span>
              </div>
            </div>
            <button
              type="button"
              className={styles.primaryButton || styles.secondaryButton}
              style={{
                background: 'var(--accent)',
                color: 'var(--bg)',
                fontWeight: 600,
                fontSize: '11px',
                padding: '6px 12px',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
              onClick={() => {
                const openModal = (window as unknown as { __openAletheModal?: (m: string) => void })
                  .__openAletheModal
                if (openModal) openModal('sync')
              }}
            >
              Conectar Google
            </button>
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
