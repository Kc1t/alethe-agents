import { Check, Cloud, MemoryStick, UserRound } from 'lucide-react'

import { useT } from '../../lib/i18n'
import type { Preferences } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AntigravityIcon, ClaudeIcon, CodexIcon } from '../icons/AgentIcons'
import { Modal } from './Modal'
import styles from './TopbarSettingsModal.module.css'

type ToggleKey = keyof Pick<
  Preferences,
  | 'topbarShowClaudeUsage'
  | 'topbarShowCodexUsage'
  | 'topbarShowAntigravityUsage'
  | 'topbarShowSync'
  | 'topbarShowProfile'
  | 'topbarShowMemory'
>

export function TopbarSettingsModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'topbarSettings')
  const closeModal = useUiStore((state) => state.closeModal)
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)
  const items: Array<{ key: ToggleKey; label: string; icon: React.ReactNode }> = [
    {
      key: 'topbarShowClaudeUsage',
      label: t('ui.titlebar.itemClaude'),
      icon: <ClaudeIcon size={18} />,
    },
    {
      key: 'topbarShowCodexUsage',
      label: t('ui.titlebar.itemCodex'),
      icon: <CodexIcon size={18} />,
    },
    {
      key: 'topbarShowAntigravityUsage',
      label: t('ui.titlebar.itemAntigravity'),
      icon: <AntigravityIcon size={18} />,
    },
    { key: 'topbarShowSync', label: t('ui.titlebar.itemSync'), icon: <Cloud size={18} /> },
    {
      key: 'topbarShowProfile',
      label: t('ui.titlebar.itemProfile'),
      icon: <UserRound size={18} />,
    },
    {
      key: 'topbarShowMemory',
      label: t('ui.titlebar.itemMemory'),
      icon: <MemoryStick size={18} />,
    },
  ]

  return (
    <Modal open={open} onClose={closeModal} title={t('ui.titlebar.customizeTitle')} width={440}>
      <p className={styles.description}>{t('ui.titlebar.customizeDescription')}</p>
      <div className={styles.list}>
        {items.map((item) => {
          const enabled = preferences[item.key]
          return (
            <button
              key={item.key}
              type="button"
              className={styles.item}
              role="switch"
              aria-checked={enabled}
              onClick={() => setPreferences({ [item.key]: !enabled })}
            >
              <span className={styles.icon}>{item.icon}</span>
              <span className={styles.label}>{item.label}</span>
              <span className={`${styles.check} ${enabled ? styles.checkActive : ''}`}>
                {enabled ? <Check size={14} /> : null}
              </span>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
