import { useNowPlaying } from '../../hooks/useNowPlaying'
import { useT } from '../../lib/i18n'
import styles from './SidebarNowPlaying.module.css'

/** Compact Now Playing row displayed above the sidebar profile footer. */
export function SidebarNowPlaying() {
  const t = useT()
  const { current } = useNowPlaying(true)

  if (!current) return null

  return (
    <div
      className={styles.row}
      title={`${current.track} — ${current.artist}${current.playing ? '' : ` (${t('widget.paused')})`}`}
    >
      <div className={styles.cover}>
        {current.cover_url ? (
          <img
            src={current.cover_url}
            alt=""
            draggable={false}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        ) : null}
      </div>
      <div className={styles.text}>
        <div className={styles.track}>{current.track}</div>
        <div className={styles.artist}>{current.artist}</div>
      </div>
      {current.playing ? <Equalizer /> : <Paused />}
    </div>
  )
}

function Equalizer() {
  return (
    <span className={styles.eq} aria-hidden="true">
      <span className={styles.eqBar} style={{ animationDelay: '0s' }} />
      <span className={styles.eqBar} style={{ animationDelay: '0.18s' }} />
      <span className={styles.eqBar} style={{ animationDelay: '0.36s' }} />
    </span>
  )
}

function Paused() {
  const t = useT()
  return (
    <span className={styles.pausedDot} aria-label={t('widget.paused')} title={t('widget.paused')}>
      ‖
    </span>
  )
}
