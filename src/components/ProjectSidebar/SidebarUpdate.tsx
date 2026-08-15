import { ArrowUpCircle } from 'lucide-react'

import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../lib/i18n'
import styles from './SidebarUpdate.module.css'

   
                                                                             
                                                                  
   
export function SidebarUpdate() {
  const t = useT()
  const info = useUiStore((s) => s.updateInfo)
  const openModal = useUiStore((s) => s.openModal_)
  if (info) {
    return (
      <button
        type="button"
        className={styles.chip}
        onClick={() => openModal('updateAvailable')}
        title={t('update.chipTitle', { version: info.version })}
      >
        <ArrowUpCircle size={13} className={styles.icon} />
        <span className={styles.label}>{t('update.chipLabel')}</span>
        <span className={styles.version}>{info.version}</span>
      </button>
    )
  }

  return null
}
