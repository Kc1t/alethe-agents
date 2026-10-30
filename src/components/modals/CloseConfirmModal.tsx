import { useState } from 'react'

import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { resolveCloseConfirm } from '../../hooks/useCloseConfirmation'
import controls from './controls.module.css'
import { Modal } from './Modal'

/** Confirms the OS-level close/quit request, with a "don't ask again" opt-out persisted in
 *  preferences. Backs `requestAppClose`/`useCloseConfirmation`, which open it instead of the
 *  native dialog once the person wants to skip this prompt. */
export function CloseConfirmModal() {
  const t = useT()
  const open = useUiStore((s) => s.closeConfirmOpen)
  const setPreferences = useProjectsStore((s) => s.setPreferences)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  const answer = (confirmed: boolean) => {
    if (confirmed && dontAskAgain) setPreferences({ skipCloseConfirm: true })
    setDontAskAgain(false)
    resolveCloseConfirm(confirmed)
  }

  return (
    <Modal
      open={open}
      onClose={() => answer(false)}
      title={t('appClose.title')}
      width={420}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={() => answer(false)}>
            {t('appClose.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnDanger}`}
            onClick={() => answer(true)}
            autoFocus
          >
            {t('appClose.confirm')}
          </button>
        </>
      }
    >
      <p>{t('appClose.message')}</p>
      <label className={controls.checkboxRow}>
        <input
          type="checkbox"
          checked={dontAskAgain}
          onChange={(event) => setDontAskAgain(event.target.checked)}
        />
        {t('appClose.dontAskAgain')}
      </label>
    </Modal>
  )
}
