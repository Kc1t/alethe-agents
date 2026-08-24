import { useT } from '../../lib/i18n'
import styles from './PlaceholderPanel.module.css'

export function VaultPanel({ projectId: _projectId }: { projectId: string }) {
  const t = useT()
  return <div className={styles.placeholder}>{t('collaborationView.comingSoon')}</div>
}
