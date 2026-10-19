import { useLayoutEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { formatShortcut } from '../../../../lib/platform'
import controls from '../../controls.module.css'
import { NarrationBehaviorSection } from '../NarrationBehaviorSection'
import { VoiceConversationSection } from '../VoiceConversationSection'
import { VoiceDictationSection } from '../VoiceDictationSection'
import { NarrationPanel } from './NarrationPanel'
import { ProviderDetail } from './ProviderDetail'
import { ProviderGrid } from './ProviderGrid'
import type { VoiceProviderId } from './providerMeta'
import { ServerDetail } from './ServerDetail'
import { SttProviderChoices } from './SttProviderChoices'
import { UsageTabs, type VoiceTab } from './UsageTabs'
import { VoiceInUseSummary } from './VoiceInUseSummary'
import styles from './VoicePage.module.css'

type Detail = {
  id: VoiceProviderId
  filter?: 'stt' | 'tts' | 'all'
  mode?: 'installed' | 'search'
}

/** The tab a preferences-search target lives in; null for targets outside the tabs. */
export function tabForTarget(target: string | null): VoiceTab | null {
  if (!target) return null
  if (target.startsWith('dictation')) return 'dictation'
  if (target === 'voice-conversation-voice' || target === 'voice-conversation-narration') {
    return 'narration'
  }
  if (target.startsWith('voice-conversation')) return 'conversation'
  return null
}

export function VoicePage({ target }: { target: string | null }) {
  const t = useT()
  const [tab, setTab] = useState<VoiceTab>(() => tabForTarget(target) ?? 'dictation')
  const [detail, setDetail] = useState<Detail | null>(null)
  // undefined: no server open; null: a new server; string: a saved server's id.
  const [serverDetail, setServerDetail] = useState<string | null | undefined>(undefined)
  const openProvider = (id: VoiceProviderId, filter?: 'stt' | 'tts') => setDetail({ id, filter })

  // Layout effect: the modal scrolls to the target on the next frame, after this re-render.
  useLayoutEffect(() => {
    const next = tabForTarget(target)
    if (next) {
      setTab(next)
      setDetail(null)
      setServerDetail(undefined)
    }
  }, [target])

  if (serverDetail !== undefined) {
    return (
      <div className={styles.page}>
        <ServerDetail serverId={serverDetail} onBack={() => setServerDetail(undefined)} />
      </div>
    )
  }

  if (detail) {
    return (
      <div className={styles.page}>
        <ProviderDetail
          id={detail.id}
          filter={detail.filter}
          initialMode={detail.mode}
          onBack={() => setDetail(null)}
        />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('prefs.categoryVoice')}</h1>
      </header>
      <VoiceInUseSummary onOpenTab={setTab} />
      <UsageTabs value={tab} onChange={setTab} />
      <div className={styles.tabBody} role="tabpanel">
        <div className={styles.introRow}>
          <p className={styles.intro}>
            {tab === 'dictation'
              ? t('prefs.voiceTabIntroDictation', { shortcut: formatShortcut('Ctrl+E') })
              : tab === 'conversation'
                ? t('prefs.voiceTabIntroConversation')
                : t('prefs.voiceTabIntroNarration')}
          </p>
          <div className={styles.introActions}>
            <button
              type="button"
              className={controls.btn}
              onClick={() =>
                setDetail({ id: 'local', filter: tab === 'narration' ? 'tts' : 'stt' })
              }
            >
              {t('prefs.voiceCompareModels')}
            </button>
            <button
              type="button"
              className={controls.btn}
              onClick={() =>
                setDetail({
                  id: 'local',
                  filter: tab === 'narration' ? 'tts' : 'stt',
                  mode: 'search',
                })
              }
            >
              {t('prefs.voiceHubMoreModels')}
            </button>
          </div>
        </div>
        {tab === 'dictation' ? (
          <>
            <SttProviderChoices use="dictation" onOpenProvider={openProvider} />
            <VoiceDictationSection />
          </>
        ) : null}
        {tab === 'conversation' ? (
          <>
            <SttProviderChoices use="conversation" onOpenProvider={openProvider} />
            <VoiceConversationSection />
          </>
        ) : null}
        {tab === 'narration' ? (
          <>
            <NarrationPanel onOpenProvider={openProvider} onOpenServer={setServerDetail} />
            <NarrationBehaviorSection />
          </>
        ) : null}
      </div>
      <ProviderGrid onOpen={openProvider} onOpenServer={setServerDetail} />
    </div>
  )
}
