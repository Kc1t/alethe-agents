import { Check, Copy, Loader2, RefreshCw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  exportPairingCode,
  type PairingCode,
  parsePairingCode,
  regeneratePairingCode,
} from '../../lib/api/p2pBridge'
import { subscribeToRendezvousEvents } from '../../lib/api/rendezvousEventBus'
import {
  adoptDiscoveredRendezvousEndpoint,
  connectRendezvous,
  sendRendezvousFrame,
  verifyDiscoveredDevice,
} from '../../lib/api/syncRendezvous'
import {
  syncAddChatContact,
  syncOpenChatContactConfirm,
  syncSealChatContactAck,
} from '../../lib/api/syncSecurity'
import { useT } from '../../lib/i18n'
import { downscaleAvatar } from '../../lib/image/downscaleAvatar'
import { getProfileImageUrl } from '../../lib/profile'
import { syncLocalIdentity } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import styles from './AddChatContactModal.module.css'

type Step = 'exchange' | 'confirm' | 'waiting'

// How long to wait for the issuer's chat_contact_confirm before giving up and letting the user
// retry — the issuer's device has to be online and process our ack for this to ever arrive. See
// docs/PROJECT_COLLABORATION_PLAN_AND_STATUS.md's "pairing codes are replayable" section: this
// wait is what actually closes that gap (previously the contact was committed immediately on
// this side, before the issuer had any say).
const CONFIRM_WAIT_MS = 25_000

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
  const [regenerating, setRegenerating] = useState(false)
  const [theirCode, setTheirCode] = useState('')
  const [displayLabel, setDisplayLabel] = useState('')
  const [verified, setVerified] = useState<
    (PairingCode & { verifiedAgreementPublicKey: string }) | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmWaitCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => confirmWaitCleanupRef.current?.()
  }, [])

  useEffect(() => {
    downscaleAvatar(getProfileImageUrl(preferences))
      .then((thumbnail) => exportPairingCode(preferences.displayName || null, thumbnail))
      .then(setMyCode)
      .catch(() => setError(t('chat.contacts.exportFailed')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const regenerateMyCode = async () => {
    setRegenerating(true)
    setError(null)
    try {
      const thumbnail = await downscaleAvatar(getProfileImageUrl(preferences))
      const code = await regeneratePairingCode(preferences.displayName || null, thumbnail)
      setMyCode(code)
      setMyCodeCopied(false)
    } catch {
      setError(t('chat.contacts.exportFailed'))
    } finally {
      setRegenerating(false)
    }
  }

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
      // Auto-detected from the other side's own profile when they exported the code — the field
      // stays editable below so this is only a starting point, never forced.
      setDisplayLabel(parsed.displayName?.trim() || parsed.deviceId)
      setStep('confirm')
    } catch (cause) {
      console.error('[chat-contact] verify failed', cause)
      setError(t('chat.contacts.verifyFailed'))
    } finally {
      setBusy(false)
    }
  }

  // Does NOT save the contact yet — only sends the ack and waits for the issuer's
  // chat_contact_confirm. Committing immediately here (as this used to) is exactly what made a
  // pasted-around pairing code a replayable bearer credential: whoever held the code got added
  // as a contact instantly, whether or not the issuer's device was even reachable to consume the
  // token. See CONFIRM_WAIT_MS's doc comment.
  const confirm = async () => {
    if (!verified) return
    setBusy(true)
    setError(null)
    try {
      // If we don't already have our own rendezvous endpoint set up and the issuer shared theirs,
      // adopt it automatically — otherwise this device would have no way to actually reach them
      // (there's no central directory; see `sync_remote_invitation.rs`'s `PairingCode` doc).
      if (verified.rendezvousEndpoint) {
        void adoptDiscoveredRendezvousEndpoint(verified.rendezvousEndpoint)
          .then(() => console.info('[chat-contact] adopted discovered endpoint', verified.rendezvousEndpoint))
          .catch((cause) => console.error('[chat-contact] adoptDiscoveredRendezvousEndpoint failed', cause))
      }
      await sendAckToIssuer()
      console.info('[chat-contact] ack sent to issuer, waiting for confirmation')
      setStep('waiting')
      waitForConfirmation()
    } catch (cause) {
      console.error('[chat-contact] sendAckToIssuer failed', cause)
      setError(t('chat.contacts.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const finalizeContact = async () => {
    if (!verified) return
    await syncAddChatContact(
      verified.accountRoute,
      verified.deviceId,
      verified.verifiedAgreementPublicKey,
      displayLabel.trim() || verified.deviceId,
      verified.avatarThumbnail,
    )
    console.info('[chat-contact] contact saved locally', { accountRoute: verified.accountRoute })
    onAdded()
  }

  const waitForConfirmation = () => {
    confirmWaitCleanupRef.current?.()
    let settled = false
    const timeoutId = window.setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribe()
      console.warn('[chat-contact] timed out waiting for chat_contact_confirm')
      setError(t('chat.contacts.confirmTimedOut'))
      setStep('confirm')
    }, CONFIRM_WAIT_MS)
    const unsubscribe = subscribeToRendezvousEvents((events) => {
      const confirmEvents = events.filter((event) => event.envelopeKind === 'chat_contact_confirm')
      if (confirmEvents.length === 0 || settled) return
      void (async () => {
        for (const event of confirmEvents) {
          if (settled || event.eventType !== 'delivery' || !event.ciphertext) continue
          try {
            const opened = await syncOpenChatContactConfirm(event.ciphertext)
            if (!opened || settled) continue
            settled = true
            window.clearTimeout(timeoutId)
            unsubscribe()
            await finalizeContact()
          } catch (cause) {
            console.warn('[chat-contact] chat_contact_confirm could not be opened', cause)
          }
        }
      })()
    })
    confirmWaitCleanupRef.current = () => {
      settled = true
      window.clearTimeout(timeoutId)
      unsubscribe()
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
      ownCode.avatarThumbnail,
    )
    await connectRendezvous()
    await sendRendezvousFrame({
      type: 'enqueue',
      kind: 'chat_contact_ack',
      id: `contact_ack_${crypto.randomUUID()}`,
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
            <div className={styles.codeActions}>
              <button
                type="button"
                className={styles.copyButton}
                disabled={!myCode}
                onClick={() => void copyMyCode()}
              >
                {myCodeCopied ? <Check size={13} /> : <Copy size={13} />}
                {myCodeCopied ? t('chat.contacts.copied') : t('chat.contacts.copy')}
              </button>
              <button
                type="button"
                className={styles.copyButton}
                disabled={!myCode || regenerating}
                title={t('chat.contacts.regenerateHint')}
                onClick={() => void regenerateMyCode()}
              >
                {regenerating ? (
                  <Loader2 size={13} className={styles.spin} />
                ) : (
                  <RefreshCw size={13} />
                )}
                {t('chat.contacts.regenerate')}
              </button>
            </div>

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
        ) : step === 'confirm' ? (
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
        ) : (
          <div className={styles.body}>
            <div className={styles.waitingState}>
              <Loader2 size={18} className={styles.spin} />
              <span>{t('chat.contacts.waitingConfirm')}</span>
            </div>
            {error ? <span className={styles.error}>{error}</span> : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                confirmWaitCleanupRef.current?.()
                setStep('confirm')
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
