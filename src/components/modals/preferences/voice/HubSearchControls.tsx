import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { languageName } from '../../../../lib/voice/modelInfo'
import { Dropdown } from '../../../ui/Dropdown'
import styles from './HubSearchControls.module.css'

/** Languages offered by the filter: the app's locales plus the ones voice models commonly cover. */
const LANGUAGES = ['pt', 'en', 'es', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru', 'hi', 'ar']

export function HubSearchControls({
  language,
  sort,
  onLanguage,
  onSort,
}: {
  language: string | null
  sort: 'likes' | 'recent'
  onLanguage: (value: string | null) => void
  onSort: (value: 'likes' | 'recent') => void
}) {
  const t = useT()
  const locale = intlLocale(getLocale())
  return (
    <div className={styles.root}>
      <label className={styles.field}>
        <span>{t('prefs.voiceHubLanguage')}</span>
        <Dropdown
          value={language ?? ''}
          ariaLabel={t('prefs.voiceHubLanguage')}
          options={[
            { value: '', label: t('prefs.voiceHubLanguageAny') },
            ...LANGUAGES.map((tag) => ({ value: tag, label: languageName(tag, locale) })),
          ]}
          onChange={(value) => onLanguage(value || null)}
        />
      </label>
      <label className={styles.field}>
        <span>{t('prefs.voiceHubSort')}</span>
        <Dropdown
          value={sort}
          ariaLabel={t('prefs.voiceHubSort')}
          options={[
            { value: 'likes', label: t('prefs.voiceHubSortLikes') },
            { value: 'recent', label: t('prefs.voiceHubSortRecent') },
          ]}
          onChange={(value) => onSort(value === 'recent' ? 'recent' : 'likes')}
        />
      </label>
    </div>
  )
}
