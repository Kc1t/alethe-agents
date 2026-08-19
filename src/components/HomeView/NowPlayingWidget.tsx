import { Music } from 'lucide-react'

import { useNowPlaying } from '../../hooks/useNowPlaying'
import { useT } from '../../lib/i18n'
import styles from './HomeView.module.css'

type Props = {
                                                                 
  enabled: boolean
}

export function NowPlayingWidget({ enabled }: Props) {
  const t = useT()
  const { current } = useNowPlaying(enabled)

  // Keep the dock empty until real playback data is available.
  if (!current) return null

  return (
    <button
      type="button"
      className={`${styles.nowPlaying} ${current.playing ? styles.nowPlayingActive : ''}`}
      aria-label={current.playing ? t('widget.nowPlaying') : t('widget.lastTrack')}
    >
      <div className={styles.nowPlayingCover}>
        {current.cover_url ? (
          <img
            src={current.cover_url}
            alt=""
            draggable={false}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        ) : (
          <Music size={18} />
        )}
        {current.playing ? (
          <span className={styles.nowPlayingCoverStatus}>
            <Equalizer />
          </span>
        ) : null}
      </div>
      <div className={styles.nowPlayingInfo}>
        <div className={styles.nowPlayingTrack}>{current.track}</div>
        <div className={styles.nowPlayingArtistRow}>
          <span className={styles.nowPlayingArtist}>{current.artist}</span>
          {current.playing ? (
            <Equalizer />
          ) : (
            <span className={styles.nowPlayingIdle}>{t('widget.last')}</span>
          )}
        </div>
      </div>
    </button>
  )
}

function Equalizer() {
  const heights = [60, 100, 40, 80]
  return (
    <span className={styles.equalizer} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className={styles.eqBar} style={{ height: `${h}%` }} />
      ))}
    </span>
  )
}
