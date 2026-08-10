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
  /** Pré-preenchido a partir de `.planning/goal.md` (sessão-filha do GSD Sync), quando existir. */
  defaultMessage: string
  onConfirm: (message: string) => void
}

/** git merge só move commits — antes de integrar uma worktree com trabalho
 *  nunca commitado, mostra o que está pendente e deixa o usuário escrever
 *  (ou revisar) a mensagem do commit automático, em vez de commitar
 *  silenciosamente com um texto genérico. */
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
