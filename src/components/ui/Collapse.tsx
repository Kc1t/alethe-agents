import { useEffect, useState } from 'react'

import styles from './Collapse.module.css'

const CLOSE_MS = 170

export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean
  className?: string
  children: React.ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [expanded, setExpanded] = useState(open)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setExpanded(true))
      return () => cancelAnimationFrame(frame)
    }
    setExpanded(false)
    const timer = window.setTimeout(() => setMounted(false), CLOSE_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!mounted) return null

  return (
    <div className={`${styles.collapse} ${expanded ? styles.expanded : ''}`}>
      <div className={`${styles.inner} ${className ?? ''}`}>{children}</div>
    </div>
  )
}
