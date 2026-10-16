import { Fragment, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { APPLE_SPEECH_MODEL_ID } from '../../../../lib/tauri'
import { CLOUD_VOICE_PROVIDERS } from '../../../../lib/voice/providers'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import { ProviderCard, type ProviderStatus } from './ProviderCard'
import styles from './ProviderGrid.module.css'
import { ProviderGroup } from './ProviderGroup'
import { cloudStatus, PROVIDER_META, type VoiceProviderId } from './providerMeta'
import { useSpeechInventory } from './useSpeechInventory'

type Filter = 'all' | 'local' | 'cloud'

export function ProviderGrid({ onOpen }: { onOpen: (id: VoiceProviderId) => void }) {
  const t = useT()
  const flags = useProjectsStore((s) => s.preferences.voiceProviders)
  const { models, states, failed, retry } = useSpeechInventory()
  const [filter, setFilter] = useState<Filter>('all')

  const appleAvailable = models.some((model) => model.id === APPLE_SPEECH_MODEL_ID)
  const localReady = models.some(
    (model) => model.kind === 'download' && states[model.id]?.status === 'ready',
  )

  const statusOf = (id: VoiceProviderId): ProviderStatus => {
    if (id === 'system') return 'connected'
    if (id === 'local') return localReady ? 'connected' : 'disconnected'
    if (id === 'apple')
      return states[APPLE_SPEECH_MODEL_ID]?.status === 'ready' ? 'connected' : 'disconnected'
    return cloudStatus(flags[id])
  }

  const actionOf = (id: VoiceProviderId): string => {
    if (id === 'local') return t('prefs.voiceActionManageModels')
    if (PROVIDER_META[id].group === 'local') return t('prefs.voiceActionManage')
    return flags[id as (typeof CLOUD_VOICE_PROVIDERS)[number]]?.configured
      ? t('prefs.voiceActionManage')
      : t('prefs.voiceActionSetUpKey')
  }

  const localIds: VoiceProviderId[] = appleAvailable
    ? ['local', 'apple', 'system']
    : ['local', 'system']
  const groups: { id: 'local' | 'cloud'; title: string; ids: VoiceProviderId[] }[] = [
    { id: 'local', title: t('prefs.voiceGroupLocal'), ids: localIds },
    { id: 'cloud', title: t('prefs.voiceGroupCloud'), ids: [...CLOUD_VOICE_PROVIDERS] },
  ]

  return (
    <section className={styles.root} data-setting-id="voice-providers" tabIndex={-1}>
      <div className={styles.header}>
        <div>
          <h2>{t('prefs.voiceAccountsTitle')}</h2>
          <p>{t('prefs.voiceAccountsDesc')}</p>
        </div>
        <div className={styles.filter} role="radiogroup" aria-label={t('prefs.voiceFilterLabel')}>
          {(['all', 'local', 'cloud'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              className={filter === id ? styles.filterActive : styles.filterOption}
              onClick={() => setFilter(id)}
            >
              {t(
                id === 'all'
                  ? 'prefs.voiceFilterAll'
                  : id === 'local'
                    ? 'prefs.voiceFilterLocal'
                    : 'prefs.voiceFilterCloud',
              )}
            </button>
          ))}
        </div>
      </div>
      {failed ? (
        <div role="alert" className={styles.failure}>
          <p>{t('prefs.voiceLoadFailed')}</p>
          <button type="button" className={`${controls.btn} ${controls.btnSm}`} onClick={retry}>
            {t('prefs.voiceRetry')}
          </button>
        </div>
      ) : null}
      {groups
        .filter((group) => filter === 'all' || filter === group.id)
        .map((group) => (
          <ProviderGroup key={group.id} title={group.title}>
            {group.ids.map((id) => (
              <ProviderCard
                key={id}
                icon={PROVIDER_META[id].icon}
                title={t(PROVIDER_META[id].name)}
                description={t(PROVIDER_META[id].description)}
                status={statusOf(id)}
                actionLabel={actionOf(id)}
                onAction={() => onOpen(id)}
              />
            ))}
          </ProviderGroup>
        ))}
    </section>
  )
}
