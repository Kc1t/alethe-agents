import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import type { WorktreePendingChange } from '../../lib/tauri'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './ConfirmWorktreeCommitModal.module.css'

export type ConfirmWorktreeCommitModalProps = {
  open: boolean
  onClose: () => void
  branchName: string
  pending: WorktreePendingChange[]
  /** Pre-filled from `.planning/goal.md` (GSD Sync child session), when it exists. */
  defaultMessage: string
  onConfirm: (message: string) => void
}

/** git merge only moves commits — before integrating a worktree with work
 *  that was never committed, shows what's pending and lets the user write
 *  (or review) the automatic commit message, instead of committing silently
 *  with generic placeholder text. */
export function ConfirmWorktreeCommitModal({
  open,
  onClose,
  branchName,
  pending,
  defaultMessage,
  onConfirm,
}: ConfirmWorktreeCommitModalProps) {
  const t = useT()
  const [message, setMessage] = useState(defaultMessage)

  useEffect(() => {
    if (open) setMessage(defaultMessage)
  }, [open, defaultMessage])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('merge.commitConfirmTitle', { branch: branchName })}
      width={520}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onClose}>
            {t('merge.testModalClose')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => onConfirm(message)}
          >
            {t('merge.commitConfirmAction')}
          </button>
        </>
      }
    >
      <p className={styles.description}>{t('merge.commitConfirmDescription')}</p>

      <div className={styles.fileList}>
        {pending.map((change) => (
          <div key={change.path} className={styles.fileRow}>
            <span className={styles.fileStatus}>{change.status || '?'}</span>
            <span className={styles.filePath}>{change.path}</span>
          </div>
        ))}
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('merge.commitConfirmMessageLabel')}</label>
        <textarea
          className={`${controls.input} ${styles.messageInput}`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('merge.commitConfirmMessagePlaceholder')}
          autoFocus
        />
      </div>
    </Modal>
  )
}
