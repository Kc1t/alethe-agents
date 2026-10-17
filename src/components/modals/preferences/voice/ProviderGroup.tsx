import type { ReactNode } from 'react'

import styles from './ProviderGroup.module.css'

/** A titled grid of provider cards, shared by the providers grid and the usage tabs. */
export function ProviderGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.grid}>{children}</div>
    </div>
  )
}
