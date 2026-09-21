import { useState } from 'react'

import type { CodexUsage } from '../../lib/tauri'
import { consumeCodexResetCredit } from '../../lib/tauri'
import { useT } from '../../lib/i18n'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'
import styles from './ResetCreditModal.module.css'

function formatExpiry(value: number): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function ResetCreditModal() {
  const t = useT()
  const open = useUiStore((state) => state.openModal === 'resetCredit')
  const closeModal = useUiStore((state) => state.closeModal)
  const usage = useUiStore((state) => state.codexUsage) as CodexUsage | null
  const setUsage = useUiStore((state) => state.setCodexUsage)
  const pushToast = useUiStore((state) => state.pushToast)
  const [busy, setBusy] = useState(false)

  const consume = async (id?: string) => {
    if (busy || !usage || usage.reset_credits < 1) return
    setBusy(true)
    try {
      setUsage(await consumeCodexResetCredit(id))
    } catch (error) {
      pushToast({ title: t('widget.resetCreditFailedTitle'), body: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const credits = usage?.reset_credit_items ?? []
  return (
    <Modal open={open} onClose={closeModal} title={t('widget.resetCreditHeading')} width={560}>
      <p className={styles.info}>{t('widget.resetCreditInfo', { n: usage?.reset_credits ?? 0 })}</p>
      <div className={styles.list}>
        {credits.length > 0 ? (
          credits.map((credit) => (
            <div className={styles.item} key={credit.id}>
              <div className={styles.copy}>
                <strong>{credit.title || t('widget.resetCreditDefaultTitle')}</strong>
                <span>{credit.description || t('widget.resetCreditDefaultDescription')}</span>
                <small>
                  {t('widget.resetCreditExpires', { date: formatExpiry(credit.expires_at_ms) })}
                </small>
              </div>
              <button
                type="button"
                className={`${controls.btn} ${controls.btnPrimary}`}
                onClick={() => void consume(credit.id)}
                disabled={busy}
              >
                {busy ? t('widget.resetCreditWorking') : t('widget.useResetCredit')}
              </button>
            </div>
          ))
        ) : (
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void consume()}
            disabled={busy}
          >
            {busy ? t('widget.resetCreditWorking') : t('widget.useResetCredit')}
          </button>
        )}
      </div>
    </Modal>
  )
}
