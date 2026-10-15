import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { isCloudProvider } from '../../../../lib/voice/providers'
import controls from '../../controls.module.css'
import { CloudKeyForm } from './CloudKeyForm'
import { LocalModelList } from './LocalModelList'
import styles from './ProviderDetail.module.css'
import { PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { useVoiceCatalog } from './useVoiceCatalog'

export function ProviderDetail({ id, onBack }: { id: VoiceProviderId; onBack: () => void }) {
  const t = useT()
  const { catalog: all, failed, retry } = useVoiceCatalog()
  const [query, setQuery] = useState('')
  const meta = PROVIDER_META[id]
  const catalog = all.find((entry) => entry.provider === id) ?? null
  const needle = query.trim().toLowerCase()
  const shown = (catalog?.models ?? []).filter((model) =>
    `${model.label} ${model.id}`.toLowerCase().includes(needle),
  )

  return (
    <div className={styles.root}>
      <nav className={styles.breadcrumb}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('prefs.voiceProvidersTitle')}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{t(meta.name)}</strong>
      </nav>
      <p className={styles.description}>{t(meta.description)}</p>
      {isCloudProvider(id) && catalog ? (
        <>
          <CloudKeyForm provider={id} keyUrl={catalog.keyUrl} />
          <h3 className={styles.subTitle}>{t('prefs.voiceDetailModels')}</h3>
          {catalog.models.length > 6 ? (
            <input
              className={`${controls.input} ${styles.search}`}
              type="search"
              value={query}
              placeholder={t('prefs.voiceSearchModels')}
              aria-label={t('prefs.voiceSearchModels')}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          <ul className={styles.modelList}>
            {shown.map((model) => (
              <li key={`${model.capability}-${model.id}`}>
                <span>{model.label}</span>
                <small>
                  {t(
                    model.capability === 'tts'
                      ? 'prefs.voiceModelKindTts'
                      : 'prefs.voiceModelKindStt',
                  )}
                </small>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {isCloudProvider(id) && !catalog && (failed || all.length > 0) ? (
        <div role="alert" className={styles.failure}>
          <p className={styles.description}>{t('prefs.voiceDetailCatalogFailed')}</p>
          <button type="button" className={controls.btn} onClick={retry}>
            {t('prefs.voiceRetry')}
          </button>
        </div>
      ) : null}
      {id === 'local' ? <LocalModelList capability="all" /> : null}
      {id === 'apple' || id === 'system' ? (
        <p className={styles.description}>{t('prefs.voiceDetailBuiltIn')}</p>
      ) : null}
    </div>
  )
}
