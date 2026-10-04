import { useMediaUrl } from '../../lib/mediaUrl'
import styles from './VideoPreview.module.css'

export function VideoPreview({ path, className }: { path: string; className?: string }) {
  const src = useMediaUrl(path)
  return (
    <video className={`${styles.video} ${className ?? ''}`} controls preload="metadata" src={src}>
      <track kind="captions" />
    </video>
  )
}
