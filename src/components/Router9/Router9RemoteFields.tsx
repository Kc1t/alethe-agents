import { Check, CircleAlert, KeyRound, Trash2, X } from 'lucide-react'
import { useId, useState } from 'react'

import { type MessageKey, useT } from '../../lib/i18n'
import { normalizeRemoteUrl, router9RemoteChecks } from '../../lib/router9'
import { router9SetRemoteKey } from '../../lib/tauri'
import type { Router9Models, Router9Preferences } from '../../lib/types'
import controls from '../modals/controls.module.css'
import styles from './Router9Settings.module.css'

type Props = {
  config: Router9Preferences
  patch: (next: Partial<Router9Preferences>) => void
  /** Whether the OS keychain holds a gateway key; the key itself never reaches the webview. */
  keySaved: boolean
  onKeyChanged: () => Promise<void>
}

type CheckState = 'ok' | 'bad' | 'info'

const MODEL_FIELDS: { key: keyof Router9Models; label: MessageKey; placeholder: string }[] = [
  { key: 'opus', label: 'router9.modelOpus', placeholder: 'cc/claude-opus-5-5' },
  { key: 'sonnet', label: 'router9.modelSonnet', placeholder: 'cc/claude-sonnet-5-5' },
  { key: 'haiku', label: 'router9.modelHaiku', placeholder: 'cc/claude-haiku-5-5' },
  { key: 'codex', label: 'router9.modelCodex', placeholder: 'cx/gpt-6.1-sol' },
]

function CheckItem({ state, text }: { state: CheckState; text: string }) {
  const Icon = state === 'ok' ? Check : state === 'bad' ? X : CircleAlert
  return (
    <li className={styles.checkItem} data-state={state}>
      <Icon size={13} className={styles.checkIcon} aria-hidden />
      <span>{text}</span>
    </li>
  )
}

/** Connection fields for a hosted 9router-compatible gateway, with live readiness and a Done check. */
export function Router9RemoteFields({ config, patch, keySaved, onKeyChanged }: Props) {
  const t = useT()
  const keyInputId = useId()
  const [draftKey, setDraftKey] = useState('')
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<'saved' | 'blocked' | null>(null)
  const checks = router9RemoteChecks(config, keySaved)
  const url = normalizeRemoteUrl(config.remoteUrl)

  const update = (next: Partial<Router9Preferences>) => {
    setOutcome(null)
    patch(next)
  }

  const writeKey = async (value: string) => {
    setKeyBusy(true)
    setKeyError(null)
    setOutcome(null)
    try {
      await router9SetRemoteKey(value)
      setDraftKey('')
      await onKeyChanged()
    } catch (error) {
      setKeyError(t('router9.remoteKeySaveFailed', { error: String(error) }))
    } finally {
      setKeyBusy(false)
    }
  }

  const handleDone = () => {
    if (url !== config.remoteUrl) patch({ remoteUrl: url })
    setOutcome(checks.url === 'ok' && checks.key === 'saved' ? 'saved' : 'blocked')
  }

  const urlItem: [CheckState, string] =
    checks.url === 'ok'
      ? ['ok', t('router9.checkUrlOk', { url })]
      : checks.url === 'invalid'
        ? ['bad', t('router9.checkUrlInvalid')]
        : ['bad', t('router9.checkUrlMissing')]
  const keyItem: [CheckState, string] =
    checks.key === 'saved'
      ? ['ok', t('router9.checkKeySaved')]
      : ['bad', t('router9.checkKeyMissing')]
  const modelsItem: [CheckState, string] = [
    checks.models === MODEL_FIELDS.length ? 'ok' : 'info',
    t('router9.checkModels', { count: String(checks.models) }),
  ]

  return (
    <div className={styles.connection}>
      <label className={styles.field}>
        <span>{t('router9.remoteUrl')}</span>
        <input
          className={controls.input}
          type="url"
          value={config.remoteUrl}
          placeholder="https://gateway.example.com"
          spellCheck={false}
          onChange={(event) => update({ remoteUrl: event.target.value })}
          onBlur={() => {
            if (url !== config.remoteUrl) patch({ remoteUrl: url })
          }}
        />
      </label>

      <div className={styles.field}>
        <label htmlFor={keyInputId}>{t('router9.remoteKey')}</label>
        <div className={styles.keyRow}>
          <input
            id={keyInputId}
            className={controls.input}
            type="password"
            value={draftKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              keySaved
                ? t('router9.remoteKeyPlaceholderSaved')
                : t('router9.remoteKeyPlaceholderEmpty')
            }
            onChange={(event) => setDraftKey(event.target.value)}
          />
          <button
            type="button"
            className={styles.quietBtn}
            disabled={keyBusy || !draftKey.trim()}
            onClick={() => void writeKey(draftKey.trim())}
          >
            <KeyRound size={12} aria-hidden />
            {t('router9.remoteKeySave')}
          </button>
          {keySaved ? (
            <button
              type="button"
              className={`${styles.quietBtn} ${styles.dangerBtn}`}
              disabled={keyBusy}
              onClick={() => void writeKey('')}
            >
              <Trash2 size={12} aria-hidden />
              {t('router9.remoteKeyRemove')}
            </button>
          ) : null}
        </div>
      </div>
      {keyError ? (
        <p className={styles.notice} data-tone="warn">
          {keyError}
        </p>
      ) : null}
      <p className={styles.hint}>{t('router9.remoteKeyHint')}</p>

      <div className={styles.connectionGrid}>
        {MODEL_FIELDS.map((field) => (
          <label key={field.key} className={styles.field}>
            <span>{t(field.label)}</span>
            <input
              className={controls.input}
              value={config.models[field.key]}
              placeholder={field.placeholder}
              spellCheck={false}
              onChange={(event) =>
                update({ models: { ...config.models, [field.key]: event.target.value.trim() } })
              }
            />
          </label>
        ))}
      </div>
      <p className={styles.hint}>
        {t('router9.models')} · {t('router9.modelsHint')}
      </p>

      <ul className={styles.checklist}>
        <CheckItem state={urlItem[0]} text={urlItem[1]} />
        <CheckItem state={keyItem[0]} text={keyItem[1]} />
        <CheckItem state={modelsItem[0]} text={modelsItem[1]} />
      </ul>

      <div className={styles.doneRow}>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnPrimary}`}
          disabled={keyBusy}
          onClick={handleDone}
        >
          <Check size={13} aria-hidden />
          {t('router9.done')}
        </button>
        {outcome ? (
          <p
            role="status"
            className={styles.doneStatus}
            data-tone={outcome === 'saved' ? 'ok' : 'warn'}
          >
            {outcome === 'saved' ? t('router9.doneConfirmed', { url }) : t('router9.doneBlocked')}
          </p>
        ) : null}
      </div>
    </div>
  )
}
