import { type MessageKey, useT } from '../../../lib/i18n'
import type { VoiceNarrationCategory, VoiceVerbosity } from '../../../lib/types'
import {
  NARRATION_CATEGORIES,
  NARRATION_PRESETS,
  narrationPreset,
} from '../../../lib/voice/narration'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'

const FILL_SECONDS = [5, 8, 12, 20, 30]
const CUSTOM = 'custom'

const PRESETS = [
  ['silent', 'prefs.voiceConvNarrationSilent'],
  ['final', 'prefs.voiceConvNarrationFinal'],
  ['normal', 'prefs.voiceConvNarrationNormal'],
  ['detailed', 'prefs.voiceConvNarrationDetailed'],
] as const satisfies readonly (readonly [VoiceVerbosity, MessageKey])[]

const CATEGORY_TEXT: Record<VoiceNarrationCategory, { label: MessageKey; desc: MessageKey }> = {
  progress: { label: 'prefs.voiceNarrateProgress', desc: 'prefs.voiceNarrateProgressDesc' },
  thinking: { label: 'prefs.voiceNarrateThinking', desc: 'prefs.voiceNarrateThinkingDesc' },
  tools: { label: 'prefs.voiceNarrateTools', desc: 'prefs.voiceNarrateToolsDesc' },
  status: { label: 'prefs.voiceNarrateStatus', desc: 'prefs.voiceNarrateStatusDesc' },
  final: { label: 'prefs.voiceNarrateFinal', desc: 'prefs.voiceNarrateFinalDesc' },
  permissions: {
    label: 'prefs.voiceNarratePermissions',
    desc: 'prefs.voiceNarratePermissionsDesc',
  },
  questions: { label: 'prefs.voiceNarrateQuestions', desc: 'prefs.voiceNarrateQuestionsDesc' },
}

/** What the assistant narrates while working; only applies while voice conversation is on. */
export function NarrationBehaviorSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const enabled = preferences.voiceConversationEnabled
  const narration = preferences.voiceNarration
  const preset = narrationPreset(narration)

  return (
    <SettingsSection
      id="voice-conversation-narration"
      title={t('prefs.voiceConvNarration')}
      description={t('prefs.voiceConvNarrationDesc')}
    >
      <Dropdown
        rootClassName={styles.dictationMicSelect}
        disabled={!enabled}
        value={preset}
        ariaLabel={t('prefs.voiceConvNarrationPreset')}
        options={[
          ...PRESETS.map(([value, key]) => ({ value, label: t(key) })),
          ...(preset === CUSTOM
            ? [{ value: CUSTOM, label: t('prefs.voiceConvNarrationCustom'), disabled: true }]
            : []),
        ]}
        onChange={(value) => {
          if (value === CUSTOM) return
          setPreferences({ voiceNarration: { ...NARRATION_PRESETS[value as VoiceVerbosity] } })
        }}
      />
      <div className={styles.toggleList}>
        {NARRATION_CATEGORIES.map((category) => {
          const text = CATEGORY_TEXT[category]
          const panelOnly = category === 'permissions' && preferences.voiceApprovalChannel === 'hud'
          return (
            <label key={category} data-disabled={!enabled || undefined}>
              <span className={styles.toggleCopy}>
                <strong>{t(text.label)}</strong>
                <span>{t(text.desc)}</span>
                {panelOnly ? <span>{t('prefs.voiceNarratePermissionsPanelOnly')}</span> : null}
              </span>
              <input
                type="checkbox"
                checked={narration[category]}
                disabled={!enabled}
                onChange={(event) =>
                  setPreferences({
                    voiceNarration: { ...narration, [category]: event.target.checked },
                  })
                }
              />
            </label>
          )
        })}
      </div>
      <p>{t('prefs.voiceConvFill')}</p>
      <p>{t('prefs.voiceConvFillDesc')}</p>
      <Dropdown
        rootClassName={styles.dictationMicSelect}
        disabled={!enabled || !narration.status}
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
