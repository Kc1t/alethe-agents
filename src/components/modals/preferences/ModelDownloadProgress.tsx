import { getLocale, intlLocale, useT } from '../../../lib/i18n'
import {
  etaSeconds,
  formatByteSize,
  formatDuration,
  formatRate,
} from '../../../lib/speech/downloadStats'
import type { SpeechDownloadProgress } from '../../../lib/tauri'
import styles from './ModelDownloadProgress.module.css'

/**
 * Progress of a speech model download: bar, bytes, current file, speed and time left. An `install`
 * (Apple's native language assets) reports only a fraction, so it shows the bar, percent and file.
 */
export function ModelDownloadProgress({
  progress,
  bytesPerSecond,
  variant = 'download',
}: {
  progress: SpeechDownloadProgress
  bytesPerSecond: number | null
  variant?: 'download' | 'install'
}) {
  const t = useT()
  const locale = intlLocale(getLocale())
  const percent = Math.round(progress.fraction * 100)
  const verifying = progress.phase === 'verifying'
  const eta = etaSeconds(progress.total - progress.downloaded, bytesPerSecond)

  return (
    <div className={styles.root}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t('prefs.dictationModelProgress', { percent })}
      >
        <div
          className={styles.bar}
          data-verifying={verifying}
          style={{ transform: `scaleX(${progress.fraction})` }}
        />
      </div>
      {variant === 'install' ? (
        <p className={styles.primary}>{t('prefs.dictationModelProgress', { percent })}</p>
      ) : (
        <>
          <p className={styles.primary}>
            {t('prefs.dictationModelProgressBytes', {
              done: formatByteSize(progress.downloaded, locale),
              total: formatByteSize(progress.total, locale),
              percent,
            })}
          </p>
          {verifying ? (
            <p className={styles.secondary}>
              {t('prefs.dictationModelVerifying', { file: progress.file })}
            </p>
          ) : bytesPerSecond !== null && eta !== null ? (
            <p className={styles.secondary}>
              {t('prefs.dictationModelSpeed', {
                speed: formatRate(bytesPerSecond, locale),
                eta: formatDuration(eta, locale),
              })}
            </p>
          ) : (
            <p className={styles.secondary}>{t('prefs.dictationModelMeasuring')}</p>
          )}
        </>
      )}
      <p className={styles.secondary}>
        {t('prefs.dictationModelFile', {
          index: progress.fileIndex,
          count: progress.fileCount,
          file: progress.file,
        })}
      </p>
    </div>
  )
}
