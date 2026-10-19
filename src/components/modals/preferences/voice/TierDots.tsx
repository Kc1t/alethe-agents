import { useT } from '../../../../lib/i18n'
import type { Tier } from '../../../../lib/voice/modelInfo'
import styles from './TierDots.module.css'

const LEVELS = [1, 2, 3] as const

/** A 1–3 tier as three dots; "≈" marks an estimate; "—" when the model has no tier. */
export function TierDots({
  tier,
  label,
  estimated,
}: {
  tier?: Tier
  label: string
  estimated?: boolean
}) {
  const t = useT()
  if (!tier) return <span className={styles.none}>—</span>
  return (
    <span
      className={styles.dots}
      role="img"
      aria-label={t('prefs.voiceTierLabel', { label, tier })}
      title={t(estimated ? 'prefs.voiceTierEstimated' : 'prefs.voiceTierSource')}
    >
      {estimated ? (
        <span className={styles.estimate} aria-hidden="true">
          ≈
        </span>
      ) : null}
      {LEVELS.map((level) => (
        <span key={level} className={styles.dot} data-filled={level <= tier} />
      ))}
    </span>
  )
}
