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

/** The saved local voice servers as provider cards, plus a button to add one. */
export function ServerGroup({ onOpen }: { onOpen: (id: string | null) => void }) {
  const t = useT()
  const servers = useVoiceServersStore((s) => s.servers)
  const loaded = useVoiceServersStore((s) => s.loaded)
  const health = useVoiceServersStore((s) => s.health)
  const refresh = useVoiceServersStore((s) => s.refresh)

  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])

  return (
    <ProviderGroup title={t('prefs.voiceGroupServers')}>
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
