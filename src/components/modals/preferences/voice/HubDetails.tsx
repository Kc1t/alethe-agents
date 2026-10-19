import { ExternalLink } from 'lucide-react'

import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { formatByteSize } from '../../../../lib/speech/downloadStats'
import { type HubModelInfo, openInBrowser } from '../../../../lib/tauri'
import { hubSourceUrl } from '../../../../lib/voice/hubModels'
import styles from './HubDetails.module.css'

/** The Hugging Face part of a model's detail panel. */
export function HubDetails({ hub, resolving }: { hub: HubModelInfo; resolving: boolean }) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const author = hub.repo.split('/')[0]
  const updated = hub.lastModified
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(hub.lastModified))
    : '—'
  const row = (label: string, value: string) => (
    <p className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span>{value}</span>
    </p>
  )
  return (
    <div className={styles.root}>
      {hub.fileCount !== null && hub.totalBytes !== null ? (
        <p className={styles.row}>
          {t('prefs.voiceHubFiles', {
            count: hub.fileCount,
            size: formatByteSize(hub.totalBytes, locale),
          })}
        </p>
      ) : resolving ? (
        <p className={styles.row}>{t('prefs.voiceHubResolving')}</p>
      ) : null}
      {hub.voiceCount !== null ? row(t('prefs.voiceColVoices'), String(hub.voiceCount)) : null}
      {row(t('prefs.voiceHubLicense'), hub.license ?? t('prefs.voiceHubUnknown'))}
      {row(t('prefs.voiceHubAuthor'), author)}
      {row(t('prefs.voiceHubUpdated'), updated)}
      {hub.commit ? row(t('prefs.voiceHubCommit'), hub.commit.slice(0, 7)) : null}
      <button
        type="button"
        className={styles.link}
        onClick={() => void openInBrowser(hubSourceUrl(hub.repo))}
      >
        {t('prefs.voiceHubOpen')}
        <ExternalLink size={12} aria-hidden="true" />
      </button>
    </div>
  )
}
