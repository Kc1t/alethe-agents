import { X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import styles from './Lightbox.module.css'

/** Full-screen media viewer with click-to-zoom: clicking anywhere on the image zooms in centered
 * on exactly the point clicked (so focusing on a corner/detail is one click, not a separate
 * zoom-in-then-pan step), clicking again zooms back out. Escape or clicking the backdrop closes
 * the whole lightbox. Video ignores the zoom click (its own `controls` need the clicks). */
export function Lightbox({ src, kind, alt, onClose }: { src: string; kind: 'image' | 'video'; alt?: string; onClose: () => void }) {
  const t = useT()
  const [zoomed, setZoomed] = useState(false)
  const [origin, setOrigin] = useState({ x: 50, y: 50 })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const toggleZoom = (event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation()
    if (zoomed) {
      setZoomed(false)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setOrigin({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    })
    setZoomed(true)
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <button type="button" className={styles.close} onClick={onClose} title={t('common.close')}>
        <X size={20} />
      </button>
      {kind === 'image' ? (
        <img
          src={src}
          alt={alt}
          className={`${styles.media} ${zoomed ? styles.zoomed : ''}`}
          style={{ transformOrigin: `${origin.x}% ${origin.y}%` }}
          onClick={toggleZoom}
        />
      ) : (
        <video src={src} controls autoPlay className={styles.media} onClick={(event) => event.stopPropagation()} />
      )}
    </div>
  )
}
