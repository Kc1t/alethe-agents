import { useEffect, useState } from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import { formatShortcut } from '../../../lib/platform'
import type { HudPreset, VoiceApprovalChannel } from '../../../lib/types'
import { offerVoiceRestart } from '../../../lib/voice/restartSessions'
import { useProjectsStore } from '../../../stores/projectsStore'
import { Dropdown } from '../../ui/Dropdown'
import controls from '../controls.module.css'
import styles from '../PreferencesModal.module.css'
import { SettingsSection } from './primitives'
import { ShortcutRecorder } from './ShortcutRecorder'

const HUD_PRESETS = [
  ['bottom-center', 'prefs.voiceHudBottomCenter'],
  ['bottom-left', 'prefs.voiceHudBottomLeft'],
  ['bottom-right', 'prefs.voiceHudBottomRight'],
  ['top-center', 'prefs.voiceHudTopCenter'],
  ['top-left', 'prefs.voiceHudTopLeft'],
  ['top-right', 'prefs.voiceHudTopRight'],
] as const satisfies readonly (readonly [HudPreset, MessageKey])[]

export function VoiceConversationSection() {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [wordsDraft, setWordsDraft] = useState(preferences.voiceInterruptWords.join(', '))
  const [triggerDraft, setTriggerDraft] = useState(preferences.voiceJevTrigger)
  const enabled = preferences.voiceConversationEnabled
  const storedWords = preferences.voiceInterruptWords.join(', ')

  useEffect(() => setWordsDraft(storedWords), [storedWords])
  useEffect(() => setTriggerDraft(preferences.voiceJevTrigger), [preferences.voiceJevTrigger])

  const segment = <T extends string>(
    value: T,
    current: T,
    label: string,
    apply: (next: T) => void,
  ) => (
    <button
      key={value}
      type="button"
      className={current === value ? styles.segmentActive : undefined}
      disabled={!enabled}
      onClick={() => apply(value)}
    >
      {label}
    </button>
  )

  return (
    <>
      <>
        <SettingsSection
          id="voice-conversation"
          title={t('prefs.voiceConv')}
          description={t('prefs.voiceConvDesc', {
            shortcut: formatShortcut(
              preferences.voiceShortcut.replace(/CmdOrCtrl|CommandOrControl/i, 'Ctrl'),
            ),
          })}
        >
          <div className={styles.segmented}>
            <button
              type="button"
              className={enabled ? styles.segmentActive : undefined}
              onClick={() => {
                if (enabled) return
                setPreferences({ voiceConversationEnabled: true })
                // Claude sessions already running have no voice hooks until restarted.
                void offerVoiceRestart().catch(() => undefined)
              }}
            >
              {t('prefs.voiceConvOn')}
            </button>
            <button
              type="button"
              className={!enabled ? styles.segmentActive : undefined}
              onClick={() => setPreferences({ voiceConversationEnabled: false })}
            >
              {t('prefs.voiceConvOff')}
            </button>
          </div>
        </SettingsSection>

        <SettingsSection
          id="voice-conversation-mode"
          title={t('prefs.voiceConvMode')}
          description={t('prefs.voiceConvModeDesc')}
        >
          <div className={styles.segmented}>
            {segment(
              'push-to-talk',
              preferences.voiceCaptureMode,
              t('prefs.voiceConvModeHold'),
              (v) => setPreferences({ voiceCaptureMode: v }),
            )}
            {segment('toggle', preferences.voiceCaptureMode, t('prefs.voiceConvModeToggle'), (v) =>
              setPreferences({ voiceCaptureMode: v }),
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          id="voice-conversation-shortcut"
          title={t('prefs.voiceConvShortcut')}
          description={t('prefs.voiceConvShortcutDesc')}
        >
          <ShortcutRecorder
            value={preferences.voiceShortcut}
            onSaved={(voiceShortcut) => setPreferences({ voiceShortcut })}
            disabled={!enabled}
          />
        </SettingsSection>

        <SettingsSection
          id="voice-conversation-hud"
          title={t('prefs.voiceHudPosition')}
          description={t('prefs.voiceHudPositionDesc')}
        >
          <Dropdown
            rootClassName={styles.dictationMicSelect}
            disabled={!enabled}
            value={preferences.voiceHudPosition}
            ariaLabel={t('prefs.voiceHudPosition')}
            options={[
              ...HUD_PRESETS.map(([value, key]) => ({ value, label: t(key) })),
              ...(preferences.voiceHudPosition === 'custom'
                ? [{ value: 'custom', label: t('prefs.voiceHudCustom'), disabled: true }]
                : []),
            ]}
            onChange={(value) => setPreferences({ voiceHudPosition: value as HudPreset })}
          />
          {preferences.voiceHudPosition === 'custom' ? (
            <button
              type="button"
              className={`${controls.btn} ${controls.btnSm}`}
              disabled={!enabled}
              onClick={() =>
                setPreferences({
                  voiceHudPosition: 'bottom-center',
                  voiceHudCustomPosition: null,
                })
              }
            >
              {t('prefs.voiceHudReset')}
            </button>
          ) : null}
        </SettingsSection>
      </>

      <>
        <SettingsSection
          id="voice-conversation-approval"
          title={t('prefs.voiceConvApproval')}
          description={t('prefs.voiceConvApprovalDesc')}
        >
          <div className={styles.segmented}>
            {(
              [
                ['both', 'prefs.voiceConvApprovalBoth'],
                ['voice', 'prefs.voiceConvApprovalVoice'],
                ['hud', 'prefs.voiceConvApprovalHud'],
              ] as const
            ).map(([value, key]) =>
              segment<VoiceApprovalChannel>(value, preferences.voiceApprovalChannel, t(key), (v) =>
                setPreferences({ voiceApprovalChannel: v }),
              ),
            )}
          </div>
          <p>{t('prefs.voiceConvDestructive')}</p>
          <p>{t('prefs.voiceConvDestructiveDesc')}</p>
          <div className={styles.segmented}>
            {segment(
              'hud',
              preferences.voiceDestructiveNeedsHud ? 'hud' : 'voice',
              t('prefs.voiceConvDestructiveHud'),
              () => setPreferences({ voiceDestructiveNeedsHud: true }),
            )}
            {segment(
              'voice',
              preferences.voiceDestructiveNeedsHud ? 'hud' : 'voice',
              t('prefs.voiceConvDestructiveVoice'),
              () => setPreferences({ voiceDestructiveNeedsHud: false }),
            )}
          </div>
          <p>{t('prefs.voiceConvMidTask')}</p>
          <p>{t('prefs.voiceConvMidTaskDesc')}</p>
          <div className={styles.segmented}>
            {segment(
              'queue',
              preferences.voiceMidTaskDefault,
              t('prefs.voiceConvMidTaskQueue'),
              (v) => setPreferences({ voiceMidTaskDefault: v }),
            )}
            {segment(
              'interrupt',
              preferences.voiceMidTaskDefault,
              t('prefs.voiceConvMidTaskInterrupt'),
              (v) => setPreferences({ voiceMidTaskDefault: v }),
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          id="voice-conversation-words"
          title={t('prefs.voiceConvWords')}
          description={t('prefs.voiceConvWordsDesc')}
        >
          <input
            className={controls.input}
            value={wordsDraft}
            disabled={!enabled}
            spellCheck={false}
            aria-label={t('prefs.voiceConvWords')}
            onChange={(event) => setWordsDraft(event.target.value)}
            onBlur={() => {
              // The matcher compares single words, so multi-word entries could never match.
              const words = [
                ...new Set(
                  wordsDraft
                    .split(',')
                    .map((word) => word.trim().toLowerCase())
                    .filter((word) => word && !/\s/.test(word)),
                ),
              ]
              setPreferences({ voiceInterruptWords: words })
              setWordsDraft(words.join(', '))
            }}
          />
          <p>{t('prefs.voiceConvTriggerDesc')}</p>
          <input
            className={controls.input}
            value={triggerDraft}
            disabled={!enabled}
            spellCheck={false}
            aria-label={t('prefs.voiceConvTrigger')}
            onChange={(event) => setTriggerDraft(event.target.value)}
            onBlur={() => {
              const next = triggerDraft.trim().toLowerCase()
              if (next) {
                setPreferences({ voiceJevTrigger: next })
                setTriggerDraft(next)
              } else {
                setTriggerDraft(preferences.voiceJevTrigger)
              }
            }}
          />
        </SettingsSection>
      </>
    </>
  )
}
