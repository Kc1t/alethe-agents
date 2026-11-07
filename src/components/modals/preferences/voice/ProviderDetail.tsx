import { ArrowLeft } from 'lucide-react'

import { useT } from '../../../../lib/i18n'
import { isCloudProvider } from '../../../../lib/voice/providers'
import controls from '../../controls.module.css'
import { CloudModelsView } from './CloudModelsView'
import { LocalModelsView } from './LocalModelsView'
import styles from './ProviderDetail.module.css'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { useVoiceCatalog } from './useVoiceCatalog'

export function ProviderDetail({
  id,
  filter,
  initialMode,
  onBack,
}: {
  id: VoiceProviderId

  filter?: 'stt' | 'tts' | 'all'

  initialMode?: 'installed' | 'search'
  onBack: () => void
}) {
  const t = useT()
  const { catalog: all, failed, retry } = useVoiceCatalog(isCloudProvider(id), id === 'openrouter')
  const meta = PROVIDER_META[id]
  const catalog = all.find((entry) => entry.provider === id) ?? null

  return (
    <div className={styles.root}>
      <nav className={styles.breadcrumb}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('prefs.voiceAccountsTitle')}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{t(meta.name)}</strong>
      </nav>
      <p className={styles.description}>{t(meta.description)}</p>
      {isCloudProvider(id) && !catalog && !failed && all.length === 0 ? (
        <p role="status">{t('prefs.voiceModelsLoading')}</p>
      ) : null}
      {isCloudProvider(id) && catalog ? <CloudModelsView provider={id} catalog={catalog} /> : null}
      {isCloudProvider(id) && !catalog && (failed || all.length > 0) ? (
        <div role="alert" className={styles.failure}>
          <p className={styles.description}>{t('prefs.voiceDetailCatalogFailed')}</p>
          <button type="button" className={controls.btn} onClick={retry}>
            {t('prefs.voiceRetry')}
          </button>
        </div>
      ) : null}
      {id === 'local' ? <LocalModelsView initialFilter={filter} initialMode={initialMode} /> : null}
    </div>
  )
}
