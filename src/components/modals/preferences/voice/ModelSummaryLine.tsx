import { intlLocale, useT } from '../../../../lib/i18n'
import { languagesLabel, modelInfoFor } from '../../../../lib/voice/modelInfo'
import { useProjectsStore } from '../../../../stores/projectsStore'
import styles from './ModelSummaryLine.module.css'
import { TierDots } from './TierDots'

/** One line under a local model picker: languages, speed and accuracy (a voice's quality) tiers. */
export function ModelSummaryLine({ modelId }: { modelId: string }) {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const info = modelInfoFor(modelId)
  const speed = t('prefs.voiceColSpeed')
  const accuracy = t(info?.use === 'tts' ? 'prefs.voiceColQuality' : 'prefs.voiceColAccuracy')
  return (
    <p className={styles.line}>
      <span>{languagesLabel(info, t, intlLocale(language))}</span>
      <span aria-hidden="true">·</span>
      <span className={styles.metric}>
        {speed} <TierDots tier={info?.speed} label={speed} estimated={info?.estimated} />
      </span>
      <span aria-hidden="true">·</span>
      <span className={styles.metric}>
        {accuracy} <TierDots tier={info?.accuracy} label={accuracy} estimated={info?.estimated} />
      </span>
    </p>
  )
}
