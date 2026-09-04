import { useEffect } from 'react'

import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { UsageStrip } from '../HomeView/UsageStrip'
import styles from './AiUsageModal.module.css'
import { Modal } from './Modal'

export function AiUsageModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'aiUsage')
  const closeModal = useUiStore((state) => state.closeModal)
  const setClaudeUsage = useUiStore((state) => state.setClaudeUsage)
  const setCodexUsage = useUiStore((state) => state.setCodexUsage)
  const setAntigravityUsage = useUiStore((state) => state.setAntigravityUsage)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.allSettled([
      getCachedClaudeUsage(true),
      getCachedCodexUsage(true),
      getCachedAntigravityUsage(true),
    ]).then(([claude, codex, antigravity]) => {
      if (cancelled) return
      setClaudeUsage(claude.status === 'fulfilled' ? claude.value : null)
      setCodexUsage(codex.status === 'fulfilled' ? codex.value : null)
      setAntigravityUsage(antigravity.status === 'fulfilled' ? antigravity.value : null)
    })
    return () => {
      cancelled = true
    }
  }, [open, setAntigravityUsage, setClaudeUsage, setCodexUsage])

  return (
    <Modal open={open} onClose={closeModal} title={t('usageModal.title')} width={920}>
      <p className={styles.description}>{t('usageModal.description')}</p>
      <UsageStrip showActivity={false} />
    </Modal>
  )
}
