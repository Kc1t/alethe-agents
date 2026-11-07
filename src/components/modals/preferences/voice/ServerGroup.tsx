import { Plus } from 'lucide-react'
import { useEffect } from 'react'

import { useT } from '../../../../lib/i18n'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import controls from '../../controls.module.css'
import { ProviderCard } from './ProviderCard'
import { ProviderGroup } from './ProviderGroup'
import { PROVIDER_META } from './providerMeta'

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function ServerGroup({ onOpen }: { onOpen: (id: string | null) => void }) {
  const t = useT()
  const servers = useVoiceServersStore((s) => s.servers)
  const loaded = useVoiceServersStore((s) => s.loaded)
  const failed = useVoiceServersStore((s) => s.failed)
  const health = useVoiceServersStore((s) => s.health)
  const refresh = useVoiceServersStore((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <ProviderGroup title={t('prefs.voiceGroupServers')}>
      {!loaded ? <p role="status">{t('prefs.voiceModelsLoading')}</p> : null}
      {failed ? (
        <div role="alert">
          <p>{t('prefs.voiceLoadFailed')}</p>
          <button type="button" className={controls.btn} onClick={() => void refresh()}>
            {t('prefs.voiceRetry')}
          </button>
        </div>
      ) : null}
      {servers.map((server) => (
        <ProviderCard
          key={server.id}
          icon={PROVIDER_META.server.icon}
          title={server.name}
          description={`${t(
            server.kind === 'fish' ? 'prefs.voiceServerKindFish' : 'prefs.voiceServerKindOpenai',
          )} · ${host(server.baseUrl)}`}
          status={health[server.id] ?? 'disconnected'}
          actionLabel={t('prefs.voiceActionManage')}
          onAction={() => onOpen(server.id)}
        />
      ))}
      <button type="button" className={controls.btn} onClick={() => onOpen(null)}>
        <Plus size={14} aria-hidden="true" />
        {t('prefs.voiceServerAdd')}
      </button>
    </ProviderGroup>
  )
}
