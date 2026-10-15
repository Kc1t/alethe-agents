import { useT } from '../../../../lib/i18n'
import type { MessageKey } from '../../../../lib/i18n/messages/en'
import styles from './UsageTabs.module.css'

export type VoiceTab = 'dictation' | 'conversation' | 'narration'

const TABS: { id: VoiceTab; label: MessageKey; hint: MessageKey }[] = [
  { id: 'dictation', label: 'prefs.voiceTabDictation', hint: 'prefs.voiceTabDictationHint' },
  {
    id: 'conversation',
    label: 'prefs.voiceTabConversation',
    hint: 'prefs.voiceTabConversationHint',
  },
  { id: 'narration', label: 'prefs.voiceTabNarration', hint: 'prefs.voiceTabNarrationHint' },
]

export function UsageTabs({
  value,
  onChange,
}: {
  value: VoiceTab
  onChange: (tab: VoiceTab) => void
}) {
  const t = useT()
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('prefs.voiceTabsLabel')}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          title={t(tab.hint)}
          className={value === tab.id ? styles.tabActive : styles.tab}
          onClick={() => onChange(tab.id)}
        >
          {t(tab.label)}
        </button>
      ))}
    </div>
  )
}
