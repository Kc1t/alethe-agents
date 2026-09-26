import { useEffect, useState } from 'react'
import { Check, Settings2 } from 'lucide-react'
import { UsageStrip } from '../HomeView/UsageStrip'
import { getCachedAntigravityUsage } from '../../lib/antigravityUsageCache'
import { getCachedClaudeUsage } from '../../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../../lib/codexUsageCache'
import { useT } from '../../lib/i18n'
import { AGENT_TYPE_LABELS } from '../../lib/types'
import { USAGE_PROVIDERS } from '../../lib/usageProviders'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentIcon } from '../icons/AgentIcons'
import { Modal } from './Modal'
import styles from './AiUsageModal.module.css'

function VisibilitySwitch({ checked, onToggle }: { checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-on={checked ? 'true' : 'false'}
      className={styles.switch}
      onClick={onToggle}
    >
      <span className={styles.switchKnob}>{checked ? <Check size={11} /> : null}</span>
    </button>
  )
}

function UsageVisibilityEditor() {
  const t = useT()
  const preferences = useProjectsStore((state) => state.preferences)
  const setPreferences = useProjectsStore((state) => state.setPreferences)

  return (
    <div className={styles.customizePanel}>
      <div className={`${styles.customizeRow} ${styles.customizeRowHead}`}>
        <span className={styles.customizeName} />
        <span className={styles.customizeToggleLabel}>{t('usageModal.showInUsagePanel')}</span>
        <span className={styles.customizeToggleLabel}>{t('usageModal.showInTopbar')}</span>
      </div>
      {USAGE_PROVIDERS.map((provider) => {
        const usageOn = preferences[provider.usagePrefKey]
        const topbarOn = preferences[provider.topbarPrefKey]
        return (
          <div key={provider.id} className={styles.customizeRow}>
            <span className={styles.customizeName}>
              <AgentIcon type={provider.agentType} size={16} theme={preferences.uiTheme} />
              {AGENT_TYPE_LABELS[provider.agentType]}
            </span>
            <VisibilitySwitch
              checked={usageOn}
              onToggle={() => setPreferences({ [provider.usagePrefKey]: !usageOn })}
            />
            <VisibilitySwitch
              checked={topbarOn}
              onToggle={() => setPreferences({ [provider.topbarPrefKey]: !topbarOn })}
            />
          </div>
        )
      })}
    </div>
  )
}

export function AiUsageModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'aiUsage')
  const closeModal = useUiStore((state) => state.closeModal)
  const setClaudeUsage = useUiStore((state) => state.setClaudeUsage)
  const setCodexUsage = useUiStore((state) => state.setCodexUsage)
  const setAntigravityUsage = useUiStore((state) => state.setAntigravityUsage)
  const [editing, setEditing] = useState(false)

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
    <Modal
      open={open}
      onClose={closeModal}
      title={t('usageModal.title')}
      width={920}
      headerAction={
        <button
          type="button"
          className={`${styles.customizeButton} ${editing ? styles.customizeButtonActive : ''}`}
          aria-label={t('usageModal.customize')}
          aria-pressed={editing}
          onClick={() => setEditing((value) => !value)}
        >
          <Settings2 size={15} />
        </button>
      }
    >
      <p className={styles.description}>{t('usageModal.description')}</p>
      {editing ? <UsageVisibilityEditor /> : null}
      <UsageStrip showActivity={false} showResetCreditAction />
    </Modal>
  )
}
