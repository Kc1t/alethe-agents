import { Globe2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import styles from './Favicon.module.css'

type FaviconProps = {
  url: string
  size?: number
  className?: string
}

/**
 * Favicon do site, com fallback em cadeia:
 *   1. `<origin>/favicon.ico`
 *   2. resolver do DuckDuckGo
 *   3. globo
 */
export function Favicon({ url, size = 15, className }: FaviconProps) {
  const sources = useMemo(() => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return []
      return [
        `${parsed.origin}/favicon.ico`,
        `https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`,
      ]
    } catch {
      return []
    }
  }, [url])

  const [attempt, setAttempt] = useState(0)
  const [previousUrl, setPreviousUrl] = useState(url)
  if (url !== previousUrl) {
    setPreviousUrl(url)
    setAttempt(0)
  }

  const src = sources[attempt]
  if (!src) return <Globe2 size={size} className={className} />

  return (
    <img
      key={src}
      src={src}
      alt=""
      width={size}
      height={size}
      className={`${styles.img} ${className ?? ''}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((index) => index + 1)}
    />
  )
}
