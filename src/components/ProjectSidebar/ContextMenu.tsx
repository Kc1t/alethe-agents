import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import styles from './ContextMenu.module.css'

export type MenuItem =
  | { kind: 'item'; label: string; onClick: () => void; danger?: boolean; icon?: ReactNode }
  | { kind: 'separator' }

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useOnClickOutside(ref, onClose)
  useOnEscape(onClose)

  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    setPosition({
      x: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    })
  }, [items, x, y])

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {items.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={i} className={styles.separator} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.danger ? styles.danger : ''}`}
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            {item.icon ? <span className={styles.itemIcon}>{item.icon}</span> : null}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
