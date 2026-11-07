import { useState } from 'react'

import { ProviderDetail } from './ProviderDetail'
import { ProviderGrid } from './ProviderGrid'
import type { VoiceProviderId } from './providerMeta'
import { ServerDetail } from './ServerDetail'
import styles from './VoicePage.module.css'

export function VoicePage() {
  const [detail, setDetail] = useState<VoiceProviderId | null>(null)
  const [serverDetail, setServerDetail] = useState<string | null | undefined>(undefined)
  if (serverDetail !== undefined)
    return (
      <div className={styles.page}>
        <ServerDetail serverId={serverDetail} onBack={() => setServerDetail(undefined)} />
      </div>
    )
  if (detail)
    return (
      <div className={styles.page}>
        <ProviderDetail id={detail} onBack={() => setDetail(null)} />
      </div>
    )
  return (
    <div className={styles.page}>
      <ProviderGrid onOpen={setDetail} onOpenServer={setServerDetail} />
    </div>
  )
}
