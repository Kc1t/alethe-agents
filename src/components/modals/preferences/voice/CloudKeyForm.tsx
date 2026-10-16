import { ExternalLink, PlugZap, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  type CloudErrorKind,
  openInBrowser,
  voiceProviderDeleteKey,
  voiceProviderSetKey,
  voiceProviderTest,
} from '../../../../lib/tauri'
import type { CloudVoiceProviderId } from '../../../../lib/types'
import { forgetProviderKey } from '../../../../lib/voice/cloudErrors'
import { useProjectsStore } from '../../../../stores/projectsStore'
import controls from '../../controls.module.css'
import styles from './CloudKeyForm.module.css'
import { PROVIDER_META } from './providerMeta'

type Feedback = { tone: 'ok' | 'error'; text: string } | null

export function CloudKeyForm({
  provider,
  keyUrl,
}: {
  provider: CloudVoiceProviderId
  keyUrl: string
}) {
  const t = useT()
  const inputId = useId()
  const flag = useProjectsStore((s) => s.preferences.voiceProviders[provider])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const name = t(PROVIDER_META[provider].name)

  const setFlag = (configured: boolean, invalid: boolean) => {
    const store = useProjectsStore.getState()
    store.setPreferences({
      voiceProviders: { ...store.preferences.voiceProviders, [provider]: { configured, invalid } },
    })
  }

  const failure = (reason: CloudErrorKind | null) =>
    t(`prefs.voiceTestFailed.${reason ?? 'other'}` as 'prefs.voiceTestFailed.other')

  const test = async () => {
    setBusy(true)
    setFeedback(null)
    try {
      const result = await voiceProviderTest(provider)
      // Read at call time: a save just before this test has already cleared the flag.
      const wasInvalid =
        useProjectsStore.getState().preferences.voiceProviders[provider]?.invalid === true
      // Only an auth failure says something about the key; a network or timeout error keeps the flag.
      setFlag(true, result.ok ? false : result.reason === 'auth' || wasInvalid)
      setFeedback(
        result.ok
          ? { tone: 'ok', text: t('prefs.voiceTestOk') }
          : { tone: 'error', text: failure(result.reason) },
      )
    } catch {
      setFeedback({ tone: 'error', text: failure('other') })
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setFeedback(null)
    try {
      await voiceProviderSetKey(provider, draft.trim())
      setDraft('')
      setFlag(true, false)
    } catch {
      setFeedback({ tone: 'error', text: t('prefs.voiceKeyRejected') })
      setBusy(false)
      return
    }
    await test()
  }

  const remove = async () => {
    setBusy(true)
    setFeedback(null)
    try {
      await voiceProviderDeleteKey(provider)
      forgetProviderKey(provider)
      setFeedback(null)
    } catch {
      setFeedback({ tone: 'error', text: t('prefs.voiceKeyRemoveFailed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.form}>
      <label htmlFor={inputId} className={styles.label}>
        {t('prefs.voiceKeyLabel')}
      </label>
      <div className={styles.row}>
        <input
          id={inputId}
          className={controls.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={
            flag?.configured
              ? '••••••••••••••••'
              : t('prefs.voiceKeyPlaceholder', { provider: name })
          }
          onChange={(event) => setDraft(event.target.value)}
        />
        <button
          type="button"
          className={`${controls.btn} ${styles.iconButton}`}
          onClick={() => void openInBrowser(keyUrl)}
        >
          <ExternalLink size={14} aria-hidden="true" />
          {t('prefs.voiceKeyGet')}
        </button>
      </div>
      <p className={styles.hint}>{t('prefs.voiceKeyHint')}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={busy || !draft.trim()}
          onClick={() => void save()}
        >
          {t('prefs.voiceKeySave')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${styles.iconButton}`}
          disabled={busy || !flag?.configured}
          onClick={() => void test()}
        >
          <PlugZap size={14} aria-hidden="true" />
          {t('prefs.voiceKeyTest')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSmDanger} ${styles.iconButton} ${styles.remove}`}
          disabled={busy || !flag?.configured}
          onClick={() => void remove()}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t('prefs.voiceKeyRemove')}
        </button>
      </div>
      {feedback ? (
        <p role="status" className={styles.feedback} data-tone={feedback.tone}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  )
}
