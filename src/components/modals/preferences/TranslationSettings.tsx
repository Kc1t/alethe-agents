import { Check, Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  translationClearApiKey,
  translationHasApiKey,
  translationSetApiKey,
} from '../../../lib/api/translation'
import { useT } from '../../../lib/i18n'
import { SettingsSection } from './primitives'

/**
 * Configures the optional translation service used to translate commit messages written in another
 * language into the app's own.
 *
 * The key goes to the OS keyring (via the backend), never to `projects.json` — and it is never read
 * back out to the UI, which only ever learns whether one is stored. The section states plainly what
 * turning this on means, since it is the only feature that sends repository content off the
 * machine, and it stays off until a key is deliberately added.
 */
export function TranslationSettings() {
  const t = useT()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    translationHasApiKey()
      .then((has) => {
        if (!cancelled) setConfigured(has)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    const key = draft.trim()
    if (!key) return
    setBusy(true)
    setError(null)
    try {
      // The backend verifies the key against the service before storing it, so a typo surfaces
      // here rather than later, as a failed translation.
      await translationSetApiKey(key)
      setConfigured(true)
      setDraft('')
    } catch {
      setError(t('prefs.translationKeyInvalid'))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      await translationClearApiKey()
      setConfigured(false)
    } catch {
      setError(t('prefs.translationClearFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="translation"
      title={t('prefs.translationTitle')}
      description={t('prefs.translationDesc')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {configured ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Check size={14} />
            <span style={{ flex: 1 }}>{t('prefs.translationConfigured')}</span>
            <button type="button" disabled={busy} onClick={() => void clear()}>
              {busy ? <Loader2 size={14} /> : <Trash2 size={14} />}
              {t('common.remove')}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="password"
              value={draft}
              placeholder={t('prefs.translationKeyPlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void save()}>
              {busy ? <Loader2 size={14} /> : null}
              {t('common.save')}
            </button>
          </div>
        )}
        {error ? <span>{error}</span> : null}
      </div>
    </SettingsSection>
  )
}
