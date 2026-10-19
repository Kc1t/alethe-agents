import { useEffect, useRef, useState } from 'react'

import { type MessageKey, useT } from '../../../lib/i18n'
import { isMacOS } from '../../../lib/platform'
import { voiceShortcutSet } from '../../../lib/tauri'
import { DEFAULT_PREFERENCES } from '../../../lib/types'
import { acceleratorFromKeyEvent, parseAccelerator } from '../../../lib/voice/shortcut'
import { useVoiceConversationStore } from '../../../stores/voiceConversationStore'
import controls from '../controls.module.css'
import styles from './ShortcutRecorder.module.css'

type Held = { mod: boolean; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }

const NO_KEYS: Held = { mod: false, ctrl: false, meta: false, shift: false, alt: false }

const ERRORS: Record<'needs-modifier' | 'alt-reserved' | 'unsupported-key', MessageKey> = {
  'needs-modifier': 'prefs.voiceShortcutNeedsModifier',
  'alt-reserved': 'prefs.voiceShortcutAltReserved',
  'unsupported-key': 'prefs.voiceShortcutUnsupported',
}

const setRecordingFlag = (shortcutRecording: boolean) =>
  useVoiceConversationStore.getState().patch({ shortcutRecording })

function modifierCaps(held: Held, mac: boolean): string[] {
  const caps: string[] = []
  if (mac) {
    if (held.mod || held.meta) caps.push('⌘')
    if (held.ctrl) caps.push('⌃')
    if (held.alt) caps.push('⌥')
    if (held.shift) caps.push('⇧')
  } else {
    if (held.mod || held.ctrl) caps.push('Ctrl')
    if (held.meta) caps.push('Super')
    if (held.alt) caps.push('Alt')
    if (held.shift) caps.push('Shift')
  }
  return caps
}

function keyLabel(code: string): string {
  return code.replace(/^Key/, '').replace(/^Digit/, '')
}

function acceleratorCaps(value: string, mac: boolean): string[] {
  const accelerator = parseAccelerator(value)
  if (!accelerator) return [value]
  return [...modifierCaps(accelerator, mac), keyLabel(accelerator.code)]
}

/**
 * Records a shortcut by pressing it. By default it is the system-wide voice shortcut, registered
 * with the OS (released while recording, so the chord reaches the page); `register` swaps that
 * for another registration, or for none when the shortcut only works inside the app.
 */
export function ShortcutRecorder({
  value,
  onSaved,
  disabled = false,
  defaultValue = DEFAULT_PREFERENCES.voiceShortcut,
  register = voiceShortcutSet,
  reject,
}: {
  value: string
  onSaved: (accelerator: string) => void
  disabled?: boolean
  /** What Reset goes back to. */
  defaultValue?: string
  /** Registers the accelerator (`null` releases it); a rejection means another app holds it. */
  register?: (accelerator: string | null) => Promise<unknown>
  /** Refuses a recorded accelerator, e.g. one another of the app's shortcuts already uses. */
  reject?: (accelerator: string) => MessageKey | null
}) {
  const t = useT()
  const mac = isMacOS()
  const [recording, setRecording] = useState(false)
  const [saving, setSaving] = useState(false)
  const [held, setHeld] = useState<Held | null>(null)
  const [error, setError] = useState<MessageKey | null>(null)
  const latest = useRef({ value, onSaved, disabled, recording, saving, register, reject })
  latest.current = { value, onSaved, disabled, recording, saving, register, reject }

  const stopRecording = (restore: boolean) => {
    latest.current.recording = false
    setRecording(false)
    setHeld(null)
    setRecordingFlag(false)
    if (restore) void latest.current.register(latest.current.value).catch(() => undefined)
  }

  const commit = (accelerator: string) => {
    const refused = latest.current.reject?.(accelerator) ?? null
    if (refused) {
      setHeld(null)
      setError(refused)
      return
    }
    latest.current.saving = true
    setSaving(true)
    setError(null)
    latest.current
      .register(accelerator)
      .then(() => {
        stopRecording(false)
        // Voice was turned off while the OS was registering it.
        if (latest.current.disabled) void latest.current.register(null).catch(() => undefined)
        latest.current.onSaved(accelerator)
      })
      .catch(() => {
        setError('prefs.voiceShortcutTaken')
        stopRecording(!latest.current.disabled)
      })
      .finally(() => {
        latest.current.saving = false
        setSaving(false)
      })
  }

  // The OS hotkey has to be released while recording, or the current chord never reaches the page.
  const startRecording = () => {
    latest.current.recording = true
    setError(null)
    setHeld(null)
    setRecording(true)
    setRecordingFlag(true)
    void latest.current.register(null).catch(() => undefined)
  }

  // A disabled voice feature must never re-register its global shortcut.
  useEffect(() => {
    if (disabled && latest.current.recording && !latest.current.saving) stopRecording(false)
  }, [disabled])

  const cancelRecording = () => {
    if (latest.current.saving) return
    setError(null)
    stopRecording(true)
  }

  const onRecordedKey = (event: KeyboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (latest.current.saving || event.repeat) return
    const result = acceleratorFromKeyEvent(event, mac)
    if ('pending' in result) {
      setHeld({
        mod: false,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      })
    } else if ('cancel' in result) {
      cancelRecording()
    } else if ('error' in result) {
      setHeld(null)
      setError(ERRORS[result.error])
    } else {
      commit(result.accelerator)
    }
  }
  const handlers = useRef({ key: onRecordedKey, blur: cancelRecording })
  handlers.current = { key: onRecordedKey, blur: cancelRecording }

  useEffect(() => {
    if (!recording) return
    // Stops the keys from reaching the page. Window capture listeners registered earlier still
    // run first, so the app's key handlers check `isRecordingShortcut()` and stand down.
    const onKeyDown = (event: KeyboardEvent) => handlers.current.key(event)
    // Leaving the window is a cancel; otherwise the global shortcut would stay released.
    const onBlur = () => handlers.current.blur()
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording])

  useEffect(
    () => () => {
      // An in-flight save finishes on its own; anything else hands the old shortcut back.
      const { recording, saving, disabled } = latest.current
      if (!recording || saving) return
      setRecordingFlag(false)
      if (!disabled) void latest.current.register(latest.current.value).catch(() => undefined)
    },
    [],
  )

  const caps = recording ? modifierCaps(held ?? NO_KEYS, mac) : acceleratorCaps(value, mac)

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span className={styles.keys} data-recording={recording ? '' : undefined}>
          {caps.map((cap) => (
            <kbd key={cap} className={styles.key}>
              {cap}
            </kbd>
          ))}
          {recording ? (
            <span className={styles.prompt}>{t('prefs.voiceShortcutRecording')}</span>
          ) : null}
        </span>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={disabled || recording}
          onClick={startRecording}
        >
          {t('prefs.voiceShortcutChange')}
        </button>
        <button
          type="button"
          className={`${controls.btn} ${controls.btnSm}`}
          disabled={disabled || saving || value === defaultValue}
          onClick={() => commit(defaultValue)}
        >
          {t('prefs.voiceShortcutReset')}
        </button>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {t(error)}
        </p>
      ) : null}
    </div>
  )
}
