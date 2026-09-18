import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

import {
  collapsedSections,
  isSectionCollapsed,
  setSectionCollapsed,
  subscribeCollapsedSections,
} from '../../../lib/settingsSections'
import styles from '../PreferencesModal.module.css'

                                                                     
                                                                        
export function SettingsSection({
  id,
  title,
  description,
  defaultCollapsed = false,
  children,
}: {
  id: string
  title: string
  description: string
  /** Ships folded: for the tall, read-only sections that make a page look like one long block. */
  defaultCollapsed?: boolean
  children: ReactNode
}) {
  const stored = useSyncExternalStore(
    subscribeCollapsedSections,
    collapsedSections,
    collapsedSections,
  )
  const collapsed = isSectionCollapsed(stored, id, defaultCollapsed)
  const bodyId = `${id}-body`
  return (
    <section
      className={styles.section}
      data-setting-id={id}
      data-collapsed={collapsed ? '' : undefined}
      tabIndex={-1}
    >
      <div className={styles.sectionHeading}>
        <h2>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => setSectionCollapsed(id, !collapsed)}
          >
            <span className={styles.sectionChevron} aria-hidden="true" />
            {title}
          </button>
        </h2>
        <p>{description}</p>
      </div>
      <div className={styles.sectionBody} id={bodyId} hidden={collapsed}>
        {children}
      </div>
    </section>
  )
}

                                                                        
                                                                      
export function Avatar({
  url,
  initial,
  large = false,
}: {
  url: string | null
  initial: string
  large?: boolean
}) {
  return url ? (
    <img
      src={url}
      alt=""
      draggable={false}
      className={`${styles.avatar} ${large ? styles.avatarLarge : ''}`}
    />
  ) : (
    <span
      className={`${styles.avatar} ${styles.avatarFallback} ${large ? styles.avatarLarge : ''}`}
    >
      {initial}
    </span>
  )
}
