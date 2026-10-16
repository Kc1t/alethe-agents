import { ArrowLeft, PlugZap, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'

import { useT } from '../../../../lib/i18n'
import {
  voiceServersDelete,
  voiceServersSave,
  voiceServersTest,
  type VoiceServerTest,
} from '../../../../lib/tauri'
import type { VoiceServerKind } from '../../../../lib/types'
import { serverErrorKey } from '../../../../lib/voice/serverErrors'
import { withTtsChoice } from '../../../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceServersStore } from '../../../../stores/voiceServersStore'
import { Dropdown } from '../../../ui/Dropdown'
import controls from '../../controls.module.css'
import styles from './ServerDetail.module.css'

/** Loopback hosts are the only ones that never leave the machine; unparsable input never warns. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host.startsWith('127.') || host === '[::1]' || host === '::1'
  } catch {
    return true
  }
}

type Feedback = { tone: 'ok' | 'error'; text: string } | null

export function ServerDetail({
  serverId,
  onBack,
}: {
  /** null creates a server. */
  serverId: string | null
  onBack: () => void
}) {
  const t = useT()
  const ids = { name: useId(), address: useId(), model: useId(), key: useId() }
  const existing = useVoiceServersStore((s) => s.servers.find((server) => server.id === serverId))
  const refresh = useVoiceServersStore((s) => s.refresh)
  const setHealth = useVoiceServersStore((s) => s.setHealth)
  const [id, setId] = useState<string | null>(serverId)
  const [kind, setKind] = useState<VoiceServerKind>(existing?.kind ?? 'openai')
  const [name, setName] = useState(existing?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(existing?.hasKey ?? false)
  const [lan, setLan] = useState(existing ? !isLoopbackUrl(existing.baseUrl) : false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  const test = async (target: string) => {
    setFeedback({ tone: 'ok', text: t('prefs.voiceServerTesting') })
    let result: VoiceServerTest
    try {
      result = await voiceServersTest(target)
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
      return
    }
    // A failed test reports loopback: true, so only a successful one is trusted for the notice.
    if (result.ok) setLan(!result.loopback)
    setHealth(target, result.ok ? 'connected' : result.reason === 'auth' ? 'invalid' : 'disconnected')
    setFeedback(
      result.ok
        ? { tone: 'ok', text: t('prefs.voiceServerOnline', { count: result.voices.length }) }
        : { tone: 'error', text: t(serverErrorKey(result.reason)) },
    )
  }

  const save = async (keyChange: string | null) => {
    setBusy(true)
    setFeedback(null)
    try {
      const saved = await voiceServersSave(
        {
          ...(id ? { id } : {}),
          name: name.trim(),
          kind,
          baseUrl: baseUrl.trim(),
          model: kind === 'openai' && model.trim() ? model.trim() : null,
        },
        keyChange,
      )
      setId(saved.server.id)
      setHasKey(saved.server.hasKey)
      setKey('')
      setLan(!saved.loopback)
      await refresh()
      await test(saved.server.id)
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!id) return
    setBusy(true)
    try {
      await voiceServersDelete(id)
      await refresh()
      onBack()
    } catch (error) {
      setFeedback({ tone: 'error', text: t(serverErrorKey(error)) })
      setBusy(false)
    }
  }

  const use = () => {
    if (!id) return
    const store = useProjectsStore.getState()
    store.setPreferences(
      withTtsChoice(store.preferences, { provider: 'server', server: id, model: '', voice: null }),
    )
  }

  return (
    <div className={styles.root}>
      <nav className={styles.breadcrumb}>
        <button type="button" className={styles.back} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t('prefs.voiceAccountsTitle')}
        </button>
        <span aria-hidden="true">/</span>
        <strong>{existing?.name ?? (name.trim() || t('prefs.voiceServerNew'))}</strong>
      </nav>
      <p className={styles.description}>{t('prefs.voiceProviderServerDesc')}</p>
      <div className={styles.form}>
        <div className={styles.field}>
          <span className={styles.label}>{t('prefs.voiceServerKind')}</span>
          <Dropdown
            value={kind}
            ariaLabel={t('prefs.voiceServerKind')}
            options={[
              { value: 'openai', label: t('prefs.voiceServerKindOpenai') },
              { value: 'fish', label: t('prefs.voiceServerKindFish') },
            ]}
            onChange={(value) => setKind(value as VoiceServerKind)}
          />
        </div>
        {/* The label holds only its text, so a hint never becomes part of the input's name. */}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.name}>
            {t('prefs.voiceServerName')}
          </label>
          <input
            id={ids.name}
            className={controls.input}
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.address}>
            {t('prefs.voiceServerAddress')}
          </label>
          <input
            id={ids.address}
            className={controls.input}
            spellCheck={false}
            placeholder="http://localhost:4123"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <small className={styles.hint}>{t('prefs.voiceServerAddressHint')}</small>
        </div>
        {kind === 'openai' ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={ids.model}>
              {t('prefs.voiceServerModel')}
            </label>
            <input
              id={ids.model}
              className={controls.input}
              spellCheck={false}
              placeholder="tts-1"
              maxLength={128}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
        ) : null}
        <div className={styles.field}>
          <label className={styles.label} htmlFor={ids.key}>
            {t('prefs.voiceServerKey')}
          </label>
          <input
            id={ids.key}
            className={controls.input}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey ? '••••••••••••••••' : ''}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <small className={styles.hint}>{t('prefs.voiceServerKeyHint')}</small>
        </div>
      </div>
      {lan ? <p className={styles.notice}>{t('prefs.voiceServerLanNotice')}</p> : null}
      <div className={styles.actions}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={busy || !name.trim() || !baseUrl.trim()}
          onClick={() => void save(key.trim() ? key.trim() : null)}
        >
          {t('prefs.voiceServerSave')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${styles.iconButton}`}
          disabled={busy || !id}
          onClick={() => id && void test(id)}
        >
          <PlugZap size={14} aria-hidden="true" />
          {t('prefs.voiceServerTest')}
        </button>
        <button
          type="button"
          className={controls.btn}
          disabled={busy || !id}
          onClick={use}
        >
          {t('prefs.voiceServerUse')}
        </button>
        {hasKey ? (
          <button
            type="button"
            className={controls.btn}
            disabled={busy}
            onClick={() => void save('')}
          >
            {t('prefs.voiceServerRemoveKey')}
          </button>
        ) : null}
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSmDanger} ${styles.iconButton} ${styles.remove}`}
          disabled={busy || !id}
          onClick={() => void remove()}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t('prefs.voiceServerRemove')}
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
