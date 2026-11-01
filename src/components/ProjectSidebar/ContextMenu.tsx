import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useOnClickOutside } from '../../hooks/useOnClickOutside'
import { useOnEscape } from '../../hooks/useOnEscape'
import { createPortal } from 'react-dom'

import styles from './ContextMenu.module.css'

export type MenuItem =
  | { kind: 'item'; label: string; onClick: () => void; danger?: boolean; icon?: ReactNode }
  | { kind: 'separator' }
  /** Replaces the menu's items in place, so a choice list opens where the menu already is. */
  | { kind: 'submenu'; label: string; items: MenuItem[]; icon?: ReactNode }

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  // Tied to the items it opened from, so a menu opened elsewhere never shows a stale submenu.
  const [submenu, setSubmenu] = useState<{ from: MenuItem[]; items: MenuItem[] } | null>(null)
  const shown = submenu?.from === items ? submenu.items : items

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
  }, [shown, x, y])

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      {shown.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={i} className={styles.separator} />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`${styles.item} ${item.kind === 'item' && item.danger ? styles.danger : ''}`}
            onClick={() => {
              if (item.kind === 'submenu') {
                setSubmenu({ from: items, items: item.items })
                return
              }
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
