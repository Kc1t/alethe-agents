import { Bell } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useOnEscape } from '../../hooks/useOnEscape'
import { formatRelativeTimestamp } from '../../lib/greeting'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './NotificationHistory.module.css'

export function NotificationHistory() {
  const t = useT()
  const language = useProjectsStore((s) => s.preferences.language)
  const notifications = useUiStore((s) => s.notifications)
  const clearNotifications = useUiStore((s) => s.clearNotifications)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const margin = 12
      const popoverWidth = Math.min(360, window.innerWidth - margin * 2)
      const popoverHeight = popoverRef.current?.getBoundingClientRect().height ?? 0
      setPosition({
        left: Math.max(
          margin,
          Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - margin),
        ),
        top: Math.max(
          margin,
          Math.min(rect.bottom + 7, window.innerHeight - popoverHeight - margin),
        ),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])
  useOnEscape((event) => {
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    triggerRef.current?.focus()
  }, open)

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-label={t('ui.titlebar.openNotifications')}
        title={t('ui.titlebar.openNotifications')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={14} />
      </button>
      {open
        ? createPortal(
            <section
              ref={popoverRef}
              className={styles.popover}
              style={{ left: position.left, top: position.top }}
              role="dialog"
              aria-label={t('ui.titlebar.notificationsTitle')}
            >
              <header className={styles.header}>
                <span>{t('ui.titlebar.notificationsTitle')}</span>
                {notifications.length > 0 ? (
                  <button type="button" className={styles.clear} onClick={clearNotifications}>
                    {t('ui.titlebar.clearNotifications')}
                  </button>
                ) : null}
              </header>
              {notifications.length > 0 ? (
                <ul className={styles.list}>
                  {notifications.map((notification) => (
                    <li className={styles.item} key={notification.id}>
                      <strong>{notification.title}</strong>
                      <span>{notification.body}</span>
                      <time>
                        {formatRelativeTimestamp(notification.createdAt, Date.now(), language)}
                      </time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>{t('home.notificationsEmptyDesc')}</p>
              )}
            </section>,
            document.body,
          )
        : null}
    </div>
  )
}
