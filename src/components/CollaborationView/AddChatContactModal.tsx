import { Check, Copy, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { exportPairingCode, type PairingCode, parsePairingCode } from '../../lib/api/p2pBridge'
import {
  adoptDiscoveredRendezvousEndpoint,
  connectRendezvous,
  sendRendezvousFrame,
  verifyDiscoveredDevice,
} from '../../lib/api/syncRendezvous'
import { syncAddChatContact, syncSealChatContactAck } from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { syncLocalIdentity } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './AddChatContactModal.module.css'

type Step = 'exchange' | 'confirm'

export function AddChatContactModal({
  onClose,
  onAdded,
}: {
  onClose: () => void
  onAdded: () => void
}) {
  const t = useT()
  const preferences = useProjectsStore((s) => s.preferences)
  const [step, setStep] = useState<Step>('exchange')
  const [myCode, setMyCode] = useState<string | null>(null)
  const [myCodeCopied, setMyCodeCopied] = useState(false)
  const [theirCode, setTheirCode] = useState('')
  const [displayLabel, setDisplayLabel] = useState('')
  const [verified, setVerified] = useState<
    (PairingCode & { verifiedAgreementPublicKey: string }) | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    exportPairingCode()
      .then(setMyCode)
      .catch(() => setError(t('chat.contacts.exportFailed')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyMyCode = async () => {
    if (!myCode) return
    try {
      await navigator.clipboard.writeText(myCode)
      setMyCodeCopied(true)
      window.setTimeout(() => setMyCodeCopied(false), 1500)
    } catch {
      // Clipboard access denied — nothing to do, the code is still shown on screen to copy by hand.
    }
  }

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      const parsed = await parsePairingCode(theirCode.trim())
      const verifiedKey = await verifyDiscoveredDevice({
        deviceId: parsed.deviceId,
        publicKey: parsed.publicKey,
        agreementPublicKey: parsed.agreementPublicKey,
        agreementBoundAtMs: parsed.agreementBoundAtMs,
        agreementBindingSignature: parsed.agreementBindingSignature,
      })
      setVerified({ ...parsed, verifiedAgreementPublicKey: verifiedKey })
      setDisplayLabel(parsed.deviceId)
      setStep('confirm')
    } catch {
      setError(t('chat.contacts.verifyFailed'))
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (!verified) return
    setBusy(true)
    setError(null)
    try {
      await syncAddChatContact(
        verified.accountRoute,
        verified.deviceId,
        verified.verifiedAgreementPublicKey,
        displayLabel.trim() || verified.deviceId,
      )
      // Automatic mutual pairing: send an ack back to the issuer over the rendezvous relay so
      // their device adds us back too, without them ever having to paste a second code. This is
      // best-effort — the local contact above is already saved either way.
      void sendAckToIssuer().catch(() => undefined)
      // If we don't already have our own rendezvous endpoint set up and the issuer shared theirs,
      // adopt it automatically — otherwise this device would have no way to actually reach them
      // (there's no central directory; see `sync_remote_invitation.rs`'s `PairingCode` doc).
      if (verified.rendezvousEndpoint) {
        void adoptDiscoveredRendezvousEndpoint(verified.rendezvousEndpoint).catch(() => undefined)
      }
      onAdded()
    } catch {
      setError(t('chat.contacts.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const sendAckToIssuer = async () => {
    if (!verified || !myCode) return
    const own = await syncLocalIdentity()
    const ownCode = await parsePairingCode(myCode)
    const ciphertext = await syncSealChatContactAck(
      verified.inviteToken,
      own.accountRoute,
      own.deviceId,
      ownCode.agreementPublicKey,
      preferences.displayName || t('profile.fallbackName'),
      verified.verifiedAgreementPublicKey,
    )
    await connectRendezvous()
    await sendRendezvousFrame({
      type: 'enqueue',
      kind: 'chat_contact_ack',
      messageId: `contact_ack_${crypto.randomUUID()}`,
      recipientAccountRoute: verified.accountRoute,
      expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      ciphertext,
    })
  }

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={styles.panel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={styles.title}>{t('chat.contacts.add')}</span>
          <button
            type="button"
            className={styles.closeButton}
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <p className={styles.notice}>{t('chat.contacts.chatOnlyNotice')}</p>

        {step === 'exchange' ? (
          <div className={styles.body}>
            <label className={styles.label}>{t('chat.contacts.myCodeLabel')}</label>
            <div className={styles.codeCard}>
              {myCode ? (
                <span className={styles.codeText}>{myCode}</span>
              ) : (
                <span className={styles.codePlaceholder}>{t('chat.contacts.generating')}</span>
              )}
            </div>
            <button
              type="button"
              className={styles.copyButton}
              disabled={!myCode}
              onClick={() => void copyMyCode()}
            >
              {myCodeCopied ? <Check size={13} /> : <Copy size={13} />}
              {myCodeCopied ? t('chat.contacts.copied') : t('chat.contacts.copy')}
            </button>

            <label className={styles.label}>{t('chat.contacts.theirCodeLabel')}</label>
            <textarea
              className={styles.codeInput}
              value={theirCode}
              onChange={(event) => setTheirCode(event.target.value)}
              placeholder={t('chat.contacts.pasteHere')}
              spellCheck={false}
            />

            {error ? <span className={styles.error}>{error}</span> : null}

            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || !theirCode.trim()}
              onClick={() => void verify()}
            >
              {busy ? <Loader2 size={13} className={styles.spin} /> : null}
              {t('chat.contacts.verify')}
            </button>
          </div>
        ) : (
          <div className={styles.body}>
            <label className={styles.label}>{t('chat.contacts.displayLabelLabel')}</label>
            <input
              className={styles.textInput}
              value={displayLabel}
              onChange={(event) => setDisplayLabel(event.target.value)}
              placeholder={t('chat.contacts.displayLabelPlaceholder')}
            />
            {error ? <span className={styles.error}>{error}</span> : null}
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? <Loader2 size={13} className={styles.spin} /> : null}
              {t('chat.contacts.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
