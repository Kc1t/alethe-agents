import { useT } from '../../../lib/i18n'
import type { VoiceVerbosity } from '../../../lib/types'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const FILL_SECONDS = [5, 8, 12, 20, 30]

/** How much the assistant narrates while working; only applies while voice conversation is on. */
export function NarrationBehaviorSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const enabled = preferences.voiceConversationEnabled

  return (
    <SettingsSection
      id="voice-conversation-narration"
      title={t('prefs.voiceConvNarration')}
      description={t('prefs.voiceConvNarrationDesc')}
    >
      <Dropdown
        rootClassName={styles.dictationMicSelect}
        disabled={!enabled}
        value={preferences.voiceVerbosity}
        ariaLabel={t('prefs.voiceConvNarration')}
        options={(
          [
            ['silent', 'prefs.voiceConvNarrationSilent'],
            ['final', 'prefs.voiceConvNarrationFinal'],
            ['normal', 'prefs.voiceConvNarrationNormal'],
            ['detailed', 'prefs.voiceConvNarrationDetailed'],
          ] as const
        ).map(([value, key]) => ({ value, label: t(key) }))}
        onChange={(value) => setPreferences({ voiceVerbosity: value as VoiceVerbosity })}
      />
      <p>{t('prefs.voiceConvFill')}</p>
      <p>{t('prefs.voiceConvFillDesc')}</p>
      <Dropdown
        rootClassName={styles.dictationMicSelect}
        disabled={!enabled}
        value={String(Math.round(preferences.voiceFillAfterMs / 1000))}
        ariaLabel={t('prefs.voiceConvFill')}
        options={FILL_SECONDS.map((seconds) => ({
          value: String(seconds),
          label: t('prefs.voiceConvSeconds', { count: seconds }),
        }))}
        onChange={(value) => setPreferences({ voiceFillAfterMs: Number(value) * 1000 })}
      />
    </SettingsSection>
  )
}
