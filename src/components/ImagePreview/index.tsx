import { useMediaUrl } from '../../lib/mediaUrl'
import styles from './ImagePreview.module.css'

export function ImagePreview({ path, className }: { path: string; className?: string }) {
  const src = useMediaUrl(path)
  return <img className={`${styles.image} ${className ?? ''}`} src={src} alt="" draggable={false} />
}
