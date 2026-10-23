import { useEffect, useState } from 'react'

import { useT } from '../../lib/i18n'
import { Modal } from './Modal'
import controls from './controls.module.css'

const PIN_PATTERN = /^\d{4,8}$/

type Props = {
  open: boolean
  onClose: () => void
  onConfirm: (pin: string) => Promise<void>
}

/** A permanent session survives restarts, so the phone has to prove itself with
 *  a PIN when it comes back. Choosing "Permanent" is not possible without one. */
export function RemotePinModal({ open, onClose, onConfirm }: Props) {
  const t = useT()
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPin('')
    setConfirm('')
    setError('')
  }, [open])

  const submit = async () => {
    if (!PIN_PATTERN.test(pin)) return setError(t('remote.pinInvalid'))
    if (pin !== confirm) return setError(t('remote.pinMismatch'))
    setSaving(true)
    try {
      await onConfirm(pin)
    } catch (cause) {
      setError(t('remote.pinSaveError', { message: String(cause) }))
    } finally {
      setSaving(false)
    }
  }

  const digitsOnly = (value: string) => value.replace(/\D/g, '').slice(0, 8)

  return (
    <Modal
      open={open}
      onClose={onClose}
      nested
      title={t('remote.pinTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={onClose} disabled={saving}>
            {t('remote.pinCancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            onClick={() => void submit()}
            disabled={saving}
          >
            {t('remote.pinSave')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <p>{t('remote.pinDescription')}</p>
        <div className={controls.field}>
          <label className={controls.label} htmlFor="remote-pin">
            {t('remote.pinLabel')}
          </label>
          <input
            id="remote-pin"
            className={controls.input}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(event) => setPin(digitsOnly(event.target.value))}
          />
        </div>
        <div className={controls.field}>
          <label className={controls.label} htmlFor="remote-pin-confirm">
            {t('remote.pinConfirmLabel')}
          </label>
          <input
            id="remote-pin-confirm"
            className={controls.input}
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(digitsOnly(event.target.value))}
          />
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
