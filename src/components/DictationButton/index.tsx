import { Loader2, Mic, MicOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useT } from '../../lib/i18n'
import { formatShortcut } from '../../lib/platform'
import { DEFAULT_SPEECH_MODEL_ID } from '../../lib/speech/audio'
import {
  speechStartCapture,
  speechStopAndTranscribe,
  speechStopCapture,
  writePty,
} from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
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
  const modelId = useProjectsStore((s) => s.preferences.dictationModelId || DEFAULT_SPEECH_MODEL_ID)
  const micId = useProjectsStore((s) => s.preferences.dictationMicrophoneId)
  const [listening, setListening] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(false)
  const holdActiveRef = useRef(false)
  const busyRef = useRef(false)

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
    if (!recordingRef.current) return
    recordingRef.current = false
    setListening(false)
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const text = await speechStopAndTranscribe(modelId)
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
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [insertTranscript, modelId, t])

  const startCapture = useCallback(async () => {
    if (recordingRef.current || busyRef.current) return
    setError(null)
    try {
      await speechStartCapture(micId)
      recordingRef.current = true
      setListening(true)
    } catch (cause) {
      recordingRef.current = false
      setError(cause instanceof Error ? cause.message : String(cause))
      setListening(false)
    }
  }, [micId])

  const toggle = useCallback(() => {
    if (recordingRef.current) void stopCapture()
    else void startCapture()
  }, [startCapture, stopCapture])

  useEffect(() => {
    if (!enabled) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (!isDictationChord(e) || e.repeat) return
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
