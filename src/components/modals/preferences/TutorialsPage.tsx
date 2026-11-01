import { ExternalLink, Play, Youtube } from 'lucide-react'
import { useState } from 'react'

import { useT } from '../../../lib/i18n'
import { openInBrowser } from '../../../lib/tauri/filesystem'
import {
  embedUrl,
  thumbnailUrl,
  TUTORIAL_VIDEOS,
  TUTORIALS_CHANNEL_URL,
  type TutorialVideo,
  watchUrl,
} from '../../../lib/tutorials'
import controls from '../controls.module.css'
import { SettingsSection } from './primitives'
import styles from './TutorialsPage.module.css'

const smallButton = `${controls.btn} ${controls.btnSm}`

function VideoCard({
  video,
  playing,
  onPlay,
}: {
  video: TutorialVideo
  playing: boolean
  onPlay: () => void
}) {
  const t = useT()
  return (
    <article className={styles.card}>
      <div className={styles.frame}>
        {playing ? (
          <iframe
            src={embedUrl(video)}
            title={video.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            className={styles.poster}
            onClick={onPlay}
            aria-label={t('tutorials.play', { title: video.title })}
          >
            <img src={thumbnailUrl(video)} alt="" loading="lazy" />
            <span className={styles.playMark} aria-hidden="true">
              <Play size={18} />
            </span>
          </button>
        )}
      </div>
      <div className={styles.copy}>
        <strong>{video.title}</strong>
        <span>
          {video.author} · {t(`tutorials.language.${video.language}`)}
        </span>
        <p>{t(video.summary)}</p>
        <div className={styles.actions}>
          <button
            type="button"
            className={smallButton}
            onClick={() => void openInBrowser(watchUrl(video))}
          >
            <ExternalLink size={13} />
            {t('tutorials.openYoutube')}
          </button>
        </div>
      </div>
    </article>
  )
}

export function TutorialsPage() {
  const t = useT()
  const [playing, setPlaying] = useState<string | null>(null)
  return (
    <SettingsSection
      id="tutorials-videos"
      title={t('tutorials.videosTitle')}
      description={t('tutorials.videosDesc')}
    >
      <div className={styles.list}>
        {TUTORIAL_VIDEOS.map((video) => (
          <VideoCard
            key={video.id}
            video={video}
            playing={playing === video.id}
            onPlay={() => setPlaying(video.id)}
          />
        ))}
      </div>
      <div className={styles.footer}>
        <span>{t('tutorials.embedHint')}</span>
        <button
          type="button"
          className={smallButton}
          onClick={() => void openInBrowser(TUTORIALS_CHANNEL_URL)}
        >
          <Youtube size={13} />
          {t('tutorials.channel')}
        </button>
      </div>
    </SettingsSection>
  )
}
