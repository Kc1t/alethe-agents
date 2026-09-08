import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import styles from './Lightbox.module.css'

export type LightboxItem = { src: string; kind: 'image' | 'video'; alt?: string }

/** Full-screen media viewer with click-to-zoom: clicking anywhere on the image zooms in centered
 * on exactly the point clicked (so focusing on a corner/detail is one click, not a separate
 * zoom-in-then-pan step), clicking again zooms back out. Escape or clicking the backdrop closes
 * the whole lightbox. Video ignores the zoom click (its own `controls` need the clicks).
 *
 * Also doubles as a gallery viewer when `items.length > 1` (e.g. opened from a grouped-attachment
 * grid) — prev/next arrows and Left/Right arrow keys step through the group without closing and
 * reopening the overlay. */
export function Lightbox({
  items,
  initialIndex = 0,
  onClose,
}: {
  items: LightboxItem[]
  initialIndex?: number
  onClose: () => void
}) {
  const t = useT()
  const [index, setIndex] = useState(initialIndex)
  const [zoomed, setZoomed] = useState(false)
  const [origin, setOrigin] = useState({ x: 50, y: 50 })
  const item = items[index]
  const hasMultiple = items.length > 1

  const goTo = (nextIndex: number) => {
    setZoomed(false)
    setIndex((nextIndex + items.length) % items.length)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (hasMultiple && event.key === 'ArrowLeft') goTo(index - 1)
      else if (hasMultiple && event.key === 'ArrowRight') goTo(index + 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, hasMultiple, index])

  if (!item) return null

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
      {hasMultiple ? (
        <>
          <button
            type="button"
            className={`${styles.nav} ${styles.navPrev}`}
            onClick={(event) => {
              event.stopPropagation()
              goTo(index - 1)
            }}
            title={t('common.previous')}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className={`${styles.nav} ${styles.navNext}`}
            onClick={(event) => {
              event.stopPropagation()
              goTo(index + 1)
            }}
            title={t('common.next')}
          >
            <ChevronRight size={22} />
          </button>
          <span className={styles.counter}>
            {index + 1} / {items.length}
          </span>
        </>
      ) : null}
      {item.kind === 'image' ? (
        <img
          key={index}
          src={item.src}
          alt={item.alt}
          className={`${styles.media} ${zoomed ? styles.zoomed : ''}`}
          style={{ transformOrigin: `${origin.x}% ${origin.y}%` }}
          onClick={toggleZoom}
        />
      ) : (
        <video
          key={index}
          src={item.src}
          controls
          autoPlay
          className={styles.media}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      {hasMultiple ? (
        <div className={styles.filmstrip} onClick={(event) => event.stopPropagation()}>
          {items.map((filmstripItem, filmstripIndex) => (
            <button
              key={filmstripIndex}
              type="button"
              className={`${styles.filmstripThumb} ${filmstripIndex === index ? styles.filmstripThumbActive : ''}`}
              onClick={() => goTo(filmstripIndex)}
            >
              {filmstripItem.kind === 'image' ? (
                <img src={filmstripItem.src} alt="" />
              ) : (
                <video src={filmstripItem.src} />
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
