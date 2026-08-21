import { Check, ChevronRight, UserRound } from 'lucide-react'

import { LOCALES, useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { GoogleIcon } from '../../icons/AgentIcons'
import controls from '../controls.module.css'
import { ImageInput } from '../ImageInput'
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
        title={t('prefs.googleSyncTitle')}
        description={t('prefs.googleSyncUnavailableDesc')}
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
                  {t('prefs.googleSyncUnavailableStatus')}
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
                color: 'var(--fg-muted)',
                fontWeight: 600,
                fontSize: '12px',
                padding: '7px 14px',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'not-allowed',
                boxShadow: 'var(--shadow-xs)',
              }}
              disabled
              title={t('mesh.unavailableHint')}
            >
              <GoogleIcon size={15} />
              <span>{t('prefs.googleSyncComingSoon')}</span>
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
