import { Check, ChevronRight, Github, UserRound } from 'lucide-react'

import { LOCALES, useT } from '../../../lib/i18n'
import { useProjectsStore } from '../../../stores/projectsStore'
import { useUiStore } from '../../../stores/uiStore'
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
  const openModal = useUiStore((state) => state.openModal_)

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

      <SettingsSection id="sync" title={t('sync.github.title')} description={t('sync.subtitle')}>
        <button type="button" className={styles.secondaryButton} onClick={() => openModal('sync')}>
          <Github size={15} />
          {t('sync.title')}
          <ChevronRight size={15} />
        </button>
      </SettingsSection>
    </>
  )
}
