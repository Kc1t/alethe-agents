import { Heart } from 'lucide-react'

import { useT } from '../../lib/i18n'
import { openInBrowser } from '../../lib/tauri'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import { CloudCard } from './sync/CloudCard'
import { FileCard } from './sync/FileCard'
import { LegacyGistCard } from './sync/LegacyGistCard'
import styles from './SyncModal.module.css'

const SPONSOR_URL = 'https://github.com/sponsors/Kc1t'

export function SyncModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'sync')
  const closeModal = useUiStore((s) => s.closeModal)

  return (
    <Modal open={open} onClose={closeModal} title={t('sync.title')} width={620}>
      <p className={styles.subtitle}>{t('sync.subtitle')}</p>

      <div className={styles.grid}>
        <CloudCard open={open} />
        <FileCard open={open} />
        <LegacyGistCard open={open} />
      </div>

      <div className={styles.sponsorRow}>
        <button
          type="button"
          className={styles.sponsor}
          onClick={() => void openInBrowser(SPONSOR_URL)}
        >
          <Heart size={15} />
          {t('sync.sponsor')}
        </button>
      </div>
    </Modal>
  )
}
