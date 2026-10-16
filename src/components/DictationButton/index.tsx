import { Loader2, Mic, MicOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { sttChoiceFor } from '../../lib/speech/engine'
import { isSpeechTooShort } from '../../lib/speech/errors'
import {
  speechPrepare,
  speechStartCapture,
  speechStopAndTranscribe,
  speechStopCapture,
  writePty,
} from '../../lib/tauri'
import { cloudFailureMessage, forgetProviderKey } from '../../lib/voice/cloudErrors'
import { isCloudProvider } from '../../lib/voice/providers'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { isRecordingShortcut } from '../../stores/voiceConversationStore'
import styles from './DictationButton.module.css'

/** How long error feedback stays visible before the mic indicator hides again. */
const ERROR_VISIBLE_MS = 4000

/** Active terminal PTY, if any. */
function activePtyId(): string | null {
  const target = useUiStore.getState().activeTerminal
  if (!target) return null
  const project = useProjectsStore.getState().projects.find((p) => p.id === target.projectId)
  const terminal = project?.terminals.find((t) => t.id === target.terminalId)
  const tab = terminal?.tabs.find((t) => t.id === terminal.activeTabId) ?? terminal?.tabs[0]
  return tab?.ptyId ?? null
}

function isDictationChord(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey
  return ctrl && !e.altKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')
}

/**
 * Local speech-to-text into the active terminal (Parakeet via sherpa-onnx).
 * Mic capture is native (cpal) so AppImage/WebKit device gaps do not matter.
 * Ctrl+E toggles or holds depending on preferences.dictationMode.
 * The floating indicator only appears while listening, transcribing, or showing an error.
 */
export function DictationButton() {
  const t = useT()
  const enabled = useProjectsStore((s) => s.preferences.dictationEnabled)
  const mode = useProjectsStore((s) => s.preferences.dictationMode)
  const voiceStt = useProjectsStore((s) => s.preferences.voiceStt)
  const engine = useMemo(() => sttChoiceFor({ voiceStt }, 'dictation'), [voiceStt])
  const micId = useProjectsStore((s) => s.preferences.dictationMicrophoneId)
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(false)
  const holdActiveRef = useRef(false)
  const busyRef = useRef(false)
  // Covers prepare + mic open; a release during it must stop the capture once it starts.
  const startingRef = useRef(false)
  const stopAfterStartRef = useRef(false)

  const insertTranscript = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const ptyId = activePtyId()
      if (!ptyId) {
        throw new Error(t('dictation.noActiveTerminal'))
      }
      await writePty(ptyId, `${trimmed} `)
    },
    [t],
  )

  const stopCapture = useCallback(async () => {
    if (!recordingRef.current) {
      if (startingRef.current) stopAfterStartRef.current = true
      return
    }
    recordingRef.current = false
    setListening(false)
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const text = await speechStopAndTranscribe(engine.modelId, engine.locale, {
        provider: engine.provider,
        fallbackLocale: engine.fallbackLocale,
        usage: 'dictation',
      })
      if (!text.trim()) {
        setError(t('dictation.emptyTranscript'))
        return
      }
      await insertTranscript(text)
    } catch (cause) {
      // If stop+transcribe failed mid-flight, make sure the native stream is dropped.
      try {
        await speechStopCapture()
      } catch {
        /* already stopped */
      }
      setError(
        isSpeechTooShort(cause)
          ? t('dictation.tooShort')
          : (cloudFailureMessage(cause, engine.provider, t) ??
              (cause instanceof Error ? cause.message : String(cause))),
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [insertTranscript, engine, t])

  const startCapture = useCallback(async () => {
    if (recordingRef.current || busyRef.current || startingRef.current) return
    setError(null)
    if (engine.needsLocale) {
      setError(t('speech.nativeLocaleRequired'))
      return
    }
    startingRef.current = true
    stopAfterStartRef.current = false
    let stopNow = false
    try {
      // On Apple this also requests the speech-recognition permission before the mic opens.
      if (engine.provider === 'apple' || isCloudProvider(engine.provider)) {
        // null: the check itself failed (e.g. the keychain), which says nothing about the key.
        const ready = await speechPrepare(engine.modelId, engine.locale, engine.provider).catch(
          () => null,
        )
        if (ready === false && isCloudProvider(engine.provider)) forgetProviderKey(engine.provider)
        if (!ready) {
          setError(t(engine.provider === 'apple' ? 'speech.nativeNotReady' : 'voice.cloud.noKey'))
          return
        }
      }
      await speechStartCapture(micId)
      recordingRef.current = true
      setListening(true)
      stopNow = stopAfterStartRef.current
    } catch (cause) {
      recordingRef.current = false
      setError(cause instanceof Error ? cause.message : String(cause))
      setListening(false)
    } finally {
      startingRef.current = false
      stopAfterStartRef.current = false
    }
    if (stopNow) await stopCapture()
  }, [engine, micId, stopCapture, t])

  const toggle = useCallback(() => {
    if (recordingRef.current || startingRef.current) void stopCapture()
    else void startCapture()
  }, [startCapture, stopCapture])

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isDictationChord(e) || e.repeat || isRecordingShortcut()) return
      e.preventDefault()
      e.stopPropagation()
      if (mode === 'hold') {
        if (holdActiveRef.current) return
        holdActiveRef.current = true
        void startCapture()
        return
      }
      toggle()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (mode !== 'hold') return
      if (e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'e' && e.key !== 'E') {
        return
      }
      if (!holdActiveRef.current) return
      holdActiveRef.current = false
      void stopCapture()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [enabled, mode, startCapture, stopCapture, toggle])

  useEffect(
    () => () => {
      if (!recordingRef.current) return
      recordingRef.current = false
      void speechStopCapture().catch(() => undefined)
    },
    [],
  )

  useEffect(() => {
    if (!error || listening || busy) return
    const timer = window.setTimeout(() => setError(null), ERROR_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [error, listening, busy])

  if (!enabled) return null

  // Idle: no floating control — Ctrl+E still starts capture via the key listener above.
  if (!listening && !busy && !error) return null

  const shortcut = formatShortcut('Ctrl+E')
  const title = error
    ? error
    : busy
      ? t('dictation.transcribing')
      : t('dictation.stopShortcut', { shortcut })

  return (
    <button
      type="button"
      className={`${styles.btn} ${listening ? styles.listening : ''} ${busy ? styles.busy : ''} ${error ? styles.error : ''}`}
      onClick={() => {
        if (busy) return
        if (listening) {
          void stopCapture()
          return
        }
        setError(null)
      }}
      disabled={busy}
      title={title}
      aria-label={busy ? t('dictation.transcribing') : t('dictation.label')}
      aria-pressed={listening}
      aria-busy={busy}
    >
      {busy ? (
        <Loader2 size={18} className={styles.spin} aria-hidden />
      ) : listening ? (
        <Mic size={18} aria-hidden />
      ) : (
        <MicOff size={18} aria-hidden />
      )}
    </button>
  )
}
