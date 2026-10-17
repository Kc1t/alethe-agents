import { Volume2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { intlLocale, useT } from '../../../../lib/i18n'
import {
  APPLE_SPEECH_MODEL_ID,
  type NativeLocale,
  speechModelStates,
  speechNativeLocales,
  ttsSpeak,
  ttsVoices,
} from '../../../../lib/tauri'
import {
  describeVoice,
  languageName,
  sortVoicesForLocale,
} from '../../../../lib/voice/voiceLanguages'
import { useProjectsStore } from '../../../../stores/projectsStore'
import { useVoiceConversationStore } from '../../../../stores/voiceConversationStore'
import controls from '../../controls.module.css'
import styles from './BuiltInProviderView.module.css'

type Permission = 'granted' | 'denied' | 'unavailable'

const PERMISSION_KEY = {
  granted: 'prefs.voiceApplePermissionGranted',
  denied: 'prefs.voiceApplePermissionDenied',
  unavailable: 'prefs.voiceApplePermissionUnavailable',
} as const

/** The engine reports permission and language together; only `denied` means no permission. */
function permissionOf(status: string | undefined): Permission | null {
  switch (status) {
    case 'ready':
    case 'needs-locale':
    case 'not-installed':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'unavailable':
      return 'unavailable'
    default:
      return null
  }
}

/** Apple Speech: the recognition permission, installed languages and those available to install. */
function AppleSpeechView() {
  const t = useT()
  const installedId = useId()
  const availableId = useId()
  const [locales, setLocales] = useState<NativeLocale[] | null>(null)
  const [permission, setPermission] = useState<Permission | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void speechNativeLocales()
      .then((list) => {
        if (!cancelled) setLocales(list)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    void speechModelStates()
      .then((states) => {
        if (cancelled) return
        const apple = states.find((state) => state.id === APPLE_SPEECH_MODEL_ID)
        setPermission(permissionOf(apple?.status))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const installed = locales?.filter((locale) => locale.installed) ?? []
  const available = locales?.filter((locale) => !locale.installed) ?? []

  return (
    <div className={styles.root}>
      {/* Opening the Privacy pane needs an x-apple.systempreferences opener; the text says where. */}
      {permission === 'denied' ? (
        <p role="alert" className={styles.warning}>
          {t('prefs.dictationNativeDenied')}
        </p>
      ) : null}
      {permission ? (
        <p className={styles.text}>
          <span className={styles.label}>{t('prefs.voiceApplePermission')}</span>
          {t(PERMISSION_KEY[permission])}
        </p>
      ) : null}
      {failed ? <p className={styles.text}>{t('prefs.voiceLoadFailed')}</p> : null}
      {locales !== null && locales.length === 0 ? (
        <p className={styles.text}>{t('prefs.dictationNativeNoLocales')}</p>
      ) : null}
      {installed.length > 0 ? (
        <>
          <h3 id={installedId} className={styles.subTitle}>
            {t('prefs.voiceAppleInstalled')}
          </h3>
          <ul className={styles.list} aria-labelledby={installedId}>
            {installed.map((locale) => (
              <li key={locale.id} data-installed="true">
                {locale.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {available.length > 0 ? (
        <>
          <h3 id={availableId} className={styles.subTitle}>
            {t('prefs.voiceAppleAvailable')}
          </h3>
          <ul className={styles.list} aria-labelledby={availableId}>
            {available.map((locale) => (
              <li key={locale.id}>{locale.name}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  )
}

/** System voice: how many voices the OS has per language, and a quick test. */
function SystemVoiceView() {
  const t = useT()
  const listId = useId()
  const language = useProjectsStore((s) => s.preferences.language)
  const narrationPaused = useVoiceConversationStore((s) => s.narrationPaused)
  const locale = intlLocale(language)
  const [counts, setCounts] = useState<[string, number][] | null>(null)
  const [failed, setFailed] = useState(false)
  const [speakFailed, setSpeakFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void ttsVoices('system')
      .then((voices) => {
        if (cancelled) return
        const byLang = new Map<string, number>()
        for (const voice of sortVoicesForLocale(voices, locale)) {
          const { lang } = describeVoice(voice.id, voice.language)
          byLang.set(lang, (byLang.get(lang) ?? 0) + 1)
        }
        setCounts([...byLang])
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [locale])

  const test = () => {
    setSpeakFailed(false)
    void ttsSpeak(t('prefs.voiceTestSentence'), {
      provider: 'system',
      model: '',
      voice: null,
      rate: 1,
    }).catch(() => setSpeakFailed(true))
  }

  return (
    <div className={styles.root}>
      <p className={styles.text}>{t('prefs.voiceDetailBuiltIn')}</p>
      <div className={styles.headingRow}>
        <h3 id={listId} className={styles.subTitle}>
          {t('prefs.voiceSystemVoicesByLanguage')}
        </h3>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={narrationPaused}
          title={narrationPaused ? t('prefs.voiceTestPausedHint') : undefined}
          onClick={test}
        >
          <Volume2 size={13} aria-hidden="true" />
          {t('prefs.voiceSystemTest')}
        </button>
      </div>
      {/* Kept consistent with the Narration tab while the conversation's narration is paused. */}
      {narrationPaused ? <p className={styles.text}>{t('prefs.voiceTestPausedHint')}</p> : null}
      {speakFailed ? (
        <p role="status" className={styles.error}>
          {t('prefs.voiceTestSpeakFailed')}
        </p>
      ) : null}
      {failed ? <p className={styles.text}>{t('prefs.voiceLoadFailed')}</p> : null}
      {counts !== null && counts.length === 0 ? <p className={styles.text}>—</p> : null}
      {counts && counts.length > 0 ? (
        <ul className={styles.counts} aria-labelledby={listId}>
          {counts.map(([lang, count]) => (
            <li key={lang}>
              <span>
                {lang === 'multi' ? t('prefs.voiceLangMulti') : languageName(lang, locale)}
              </span>
              <span className={styles.count}>{count}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Detail page of a provider built into the OS, which has no key and no model to pick. */
export function BuiltInProviderView({ id }: { id: 'apple' | 'system' }) {
  return id === 'apple' ? <AppleSpeechView /> : <SystemVoiceView />
}
