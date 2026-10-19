import { useEffect, useState } from 'react'

import { speechCaptureLevel } from '../../lib/tauri'
import styles from './VoiceSpectrum.module.css'

const LEVEL_POLL_MS = 60
const SPECTRUM_BARS = 40
const SILENT_LEVEL = 0.005
const SILENT_POLLS_BEFORE_WARNING = 12
const SILENCE: number[] = Array.from({ length: SPECTRUM_BARS }, () => 0)

/** Live mic level as a scrolling bar spectrum; polls only while `live`. */
export function VoiceSpectrum({
  live,
  onSilent,
}: {
  live: boolean
  onSilent?: (silent: boolean) => void
}) {
  const [levels, setLevels] = useState<number[]>(SILENCE)

  useEffect(() => {
    if (!live) {
      setLevels(SILENCE)
      return
    }
    let silentPolls = 0
    const id = window.setInterval(() => {
      void speechCaptureLevel()
        .then((next) => {
          setLevels((previous) => [...previous.slice(1), next])
          if (next > SILENT_LEVEL) {
            silentPolls = 0
            onSilent?.(false)
            return
          }
          silentPolls += 1
          if (silentPolls > SILENT_POLLS_BEFORE_WARNING) onSilent?.(true)
        })
        .catch(() => undefined)
    }, LEVEL_POLL_MS)
    return () => window.clearInterval(id)
  }, [live, onSilent])

  return (
    <div className={styles.spectrum} data-live={live} role="presentation">
      {levels.map((value, index) => (
        <span
          key={index}
          className={styles.spectrumBar}
          style={{ transform: `scaleY(${1 + Math.min(1, value * 4) * 11})` }}
        />
      ))}
    </div>
  )
}
