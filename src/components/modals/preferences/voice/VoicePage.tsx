import { useLayoutEffect, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import { formatShortcut } from '../../../../lib/platform'
import { NarrationBehaviorSection } from '../NarrationBehaviorSection'
import { VoiceConversationSection } from '../VoiceConversationSection'
import { VoiceDictationSection } from '../VoiceDictationSection'
import { NarrationPanel } from './NarrationPanel'
import { ProviderDetail } from './ProviderDetail'
import { ProviderGrid } from './ProviderGrid'
import type { VoiceProviderId } from './providerMeta'
import { SttProviderChoices } from './SttProviderChoices'
import { UsageTabs, type VoiceTab } from './UsageTabs'
import styles from './VoicePage.module.css'

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
  const [detail, setDetail] = useState<VoiceProviderId | null>(null)

  // Layout effect: the modal scrolls to the target on the next frame, after this re-render.
  useLayoutEffect(() => {
    const next = tabForTarget(target)
    if (next) {
      setTab(next)
      setDetail(null)
    }
  }, [target])

  if (detail) {
    return (
      <div className={styles.page}>
        <ProviderDetail id={detail} onBack={() => setDetail(null)} />
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('prefs.categoryVoice')}</h1>
        <p>{t('prefs.categoryVoiceDesc')}</p>
      </header>
      <UsageTabs value={tab} onChange={setTab} />
      <div className={styles.tabBody} role="tabpanel">
        <p className={styles.intro}>
          {tab === 'dictation'
            ? t('prefs.voiceTabIntroDictation', { shortcut: formatShortcut('Ctrl+E') })
            : tab === 'conversation'
              ? t('prefs.voiceTabIntroConversation')
              : t('prefs.voiceTabIntroNarration')}
        </p>
        {tab === 'dictation' ? (
          <>
            <SttProviderChoices use="dictation" onOpenProvider={setDetail} />
            <VoiceDictationSection />
          </>
        ) : null}
        {tab === 'conversation' ? (
          <>
            <SttProviderChoices use="conversation" onOpenProvider={setDetail} />
            <VoiceConversationSection />
          </>
        ) : null}
        {tab === 'narration' ? (
          <>
            <NarrationPanel onOpenProvider={setDetail} />
            <NarrationBehaviorSection />
          </>
        ) : null}
      </div>
      <ProviderGrid onOpen={setDetail} />
    </div>
  )
}
