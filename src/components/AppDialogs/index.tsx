import { useState, useSyncExternalStore } from 'react'

import {
  activeAppDialog,
  type AppDialogRequest,
  settleAppDialog,
  subscribeAppDialogs,
} from '../../lib/appDialogs'
import { useT } from '../../lib/i18n'
import controls from '../modals/controls.module.css'
import { Modal } from '../modals/Modal'
import styles from './AppDialogs.module.css'

/** Renders the queued in-app confirm/message/prompt dialogs, one at a time. */
export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialogs, activeAppDialog, activeAppDialog)
  if (!request) return null
  return <AppDialog key={request.id} request={request} />
}

function AppDialog({ request }: { request: AppDialogRequest }) {
  const t = useT()
  const [value, setValue] = useState(request.defaultValue ?? '')
  const isPrompt = request.kind === 'prompt'
  const isMessage = request.kind === 'message'

  const accept = () =>
    settleAppDialog(request.id, { confirmed: true, value: isPrompt ? value : null })
  const cancel = () => settleAppDialog(request.id, { confirmed: false, value: null })

  const title =
    request.title ??
    (isPrompt
      ? t('appDialog.promptTitle')
      : isMessage
        ? t('appDialog.messageTitle')
        : t('appDialog.confirmTitle'))

  return (
    <Modal
      open
      nested
      onClose={isMessage ? accept : cancel}
      title={title}
      footer={
        <>
          {!isMessage && (
            <button type="button" className={controls.btn} onClick={cancel}>
              {request.cancelLabel ?? t('common.cancel')}
            </button>
          )}
          <button
            type="button"
            data-autofocus=""
            className={`${controls.btn} ${request.danger ? controls.btnDanger : controls.btnPrimary}`}
            onClick={accept}
          >
            {request.okLabel ?? t('common.ok')}
          </button>
        </>
      }
    >
      <p className={styles.message}>{request.message}</p>
      {isPrompt && (
        <input
          className={`${controls.input} ${styles.input}`}
          aria-label={request.message}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              accept()
            }
          }}
        />
      )}
    </Modal>
  )
}
