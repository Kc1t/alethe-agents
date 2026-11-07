import type { ReactNode } from 'react'

import styles from './ProviderGroup.module.css'

export function ProviderGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.grid}>{children}</div>
    </div>
  )
}
