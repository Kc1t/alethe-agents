import { useEffect, useState } from 'react'

import { getLocale, intlLocale, useT } from '../../../../lib/i18n'
import { type TtsVoice, ttsVoices } from '../../../../lib/tauri'
import { voiceOption } from '../../../../lib/voice/voiceLanguages'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { Dropdown } from '../../../ui/Dropdown'
import styles from './LocalVoiceSelect.module.css'

/**
 * Picks the speaker of the downloaded multi-voice local model that narrates. Rendered only for
 * the current narration model, so it never loads voices for a model nobody uses.
 */
export function LocalVoiceSelect({ modelId }: { modelId: string }) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const voiceTts = useProjectsStore((s) => s.preferences.voiceTts)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [voices, setVoices] = useState<TtsVoice[]>([])

  useEffect(() => {
    let cancelled = false
    void ttsVoices('local', modelId)
      .then((list) => {
        if (!cancelled) setVoices(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [modelId])

  if (voices.length < 2) return null
  const active = voiceTts.provider === 'local' && voiceTts.model === modelId
  return (
    <label className={styles.field}>
      <span>{t('prefs.voiceConvVoice')}</span>
      <Dropdown
        value={active ? (voiceTts.voice ?? '') : ''}
        ariaLabel={t('prefs.voiceConvVoice')}
        searchable={voices.length > 8}
        options={voices.map((voice) => voiceOption(voice, locale, t))}
        onChange={(value) =>
          setPreferences(
            withTtsChoice(
              { voiceTts },
              { provider: 'local', model: modelId, voice: value || null },
            ),
          )
        }
      />
    </label>
  )
}
