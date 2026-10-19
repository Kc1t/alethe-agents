import { getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window'
import { Mic, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useReadOnlyProjectsHydration } from '../../hooks/useReadOnlyProjectsHydration'
import { useT } from '../../lib/i18n'
import { isMacOS } from '../../lib/platform'
import { onVoiceHudState, voiceHudAction, voiceHudMoved, voiceHudSnapshot } from '../../lib/tauri'
import { useAppliedTheme } from '../../lib/themes'
import { decodeHudState, type HudViewState } from '../../lib/voice/hudState'
import { useProjectsStore } from '../../stores/projectsStore'
import {
  type VoiceConversationAction,
  VoiceConversationView,
} from '../VoiceConversation/VoiceConversationView'
import styles from './VoiceHud.module.css'

const MOVE_DEBOUNCE_MS = 300
/** A drag counts as over once the window has been still this long. */
const DRAG_SETTLE_MS = 1_000

/** A HUD drag that follows the pointer: where it started, and the window's place then. */
type PointerDrag = {
  startX: number
  startY: number
  /** The window's outer position in physical pixels, known once the window answers. */
  origin: { x: number; y: number; scale: number } | null
  /** The latest pointer position not yet applied. */
  pending?: { x: number; y: number }
  frame?: number
}

/** The floating HUD window: renders the state the main window publishes and sends actions back. */
export function VoiceHud() {
  const t = useT()
  const hydrated = useProjectsStore((s) => s.hydrated)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')
  const appliedTheme = useAppliedTheme(uiTheme)
  const [hud, setHud] = useState<HudViewState | null>(null)
  // Only a drag the person started from the strip is reported: placing the HUD moves it too.
  const dragging = useRef(false)
  const pointerDrag = useRef<PointerDrag | null>(null)

  // Read once for plugin themes; language and theme then come with each published state, so a
  // hidden HUD does not re-read the whole profile on every save.
  useReadOnlyProjectsHydration({ reloadOnSave: false })

  // Also after hydration, which would otherwise put back the values saved on disk.
  useEffect(() => {
    if (!hud) return
    const { language, uiTheme, visualStyle } = hud
    const { preferences } = useProjectsStore.getState()
    if (
      preferences.language === language &&
      preferences.uiTheme === uiTheme &&
      preferences.visualStyle === visualStyle
    ) {
      return
    }
    useProjectsStore.setState({ preferences: { ...preferences, language, uiTheme, visualStyle } })
  }, [hud, hydrated])

  useEffect(() => {
    if (!hydrated && !hud) return
    document.documentElement.dataset.theme = appliedTheme
    document.documentElement.dataset.visualStyle = visualStyle
  }, [appliedTheme, hud, hydrated, visualStyle])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void voiceHudSnapshot()
      .then((json) => {
        if (!cancelled) setHud((current) => current ?? decodeHudState(json))
      })
      .catch(() => undefined)
    void onVoiceHudState((json) => {
      const next = decodeHudState(json)
      if (next) setHud(next)
    }).then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let settle: ReturnType<typeof setTimeout> | null = null
    let unlisten: (() => void) | undefined
    let cancelled = false
    void getCurrentWindow()
      .onMoved(() => {
        if (!dragging.current) return
        if (timer) clearTimeout(timer)
        if (settle) clearTimeout(settle)
        timer = setTimeout(() => void voiceHudMoved().catch(() => undefined), MOVE_DEBOUNCE_MS)
        // Disarmed only once the window settles, so a drag that pauses still reports where it ends.
        settle = setTimeout(() => {
          dragging.current = false
        }, MOVE_DEBOUNCE_MS + DRAG_SETTLE_MS)
      })
      .then((off) => {
        if (cancelled) off()
        else unlisten = off
      })
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (settle) clearTimeout(settle)
      unlisten?.()
    }
  }, [])

  function endPointerDrag() {
    const drag = pointerDrag.current
    if (drag?.frame !== undefined) cancelAnimationFrame(drag.frame)
    pointerDrag.current = null
  }

  const send = (action: VoiceConversationAction) =>
    void voiceHudAction(JSON.stringify(action)).catch(() => undefined)
  const drag = (
    <div
      className={styles.drag}
      aria-label={t('voice.hud.drag')}
      title={t('voice.hud.drag')}
      onPointerDown={(event) => {
        if (event.button > 0) return
        dragging.current = true
        if (!isMacOS()) {
          void getCurrentWindow()
            .startDragging()
            .catch(() => undefined)
          return
        }
        // macOS starts a native drag from the app's current event, which is some other window's
        // event while Alethe is active; the HUD follows the pointer itself instead.
        event.currentTarget.setPointerCapture(event.pointerId)
        const drag: PointerDrag = { startX: event.screenX, startY: event.screenY, origin: null }
        pointerDrag.current = drag
        const win = getCurrentWindow()
        void Promise.all([win.outerPosition(), win.scaleFactor()])
          .then(([position, scale]) => {
            drag.origin = { x: position.x, y: position.y, scale }
          })
          .catch(() => {
            if (pointerDrag.current === drag) pointerDrag.current = null
          })
      }}
      onPointerMove={(event) => {
        const drag = pointerDrag.current
        if (!drag?.origin) return
        drag.pending = { x: event.screenX, y: event.screenY }
        if (drag.frame !== undefined) return
        drag.frame = requestAnimationFrame(() => {
          drag.frame = undefined
          const { origin, pending } = drag
          if (!origin || !pending) return
          const x = Math.round(origin.x + (pending.x - drag.startX) * origin.scale)
          const y = Math.round(origin.y + (pending.y - drag.startY) * origin.scale)
          void getCurrentWindow()
            .setPosition(new PhysicalPosition(x, y))
            .catch(() => undefined)
        })
      }}
      onPointerUp={endPointerDrag}
      onPointerCancel={endPointerDrag}
      onLostPointerCapture={endPointerDrag}
    />
  )

  // The window can be shown before the first state arrives: never a blank gray box.
  if (!hud) {
    return (
      <div className={styles.root}>
        {drag}
        <section className={styles.placeholder} aria-label={t('voice.conv.title')}>
          <Mic size={14} aria-hidden className={styles.placeholderIcon} />
          <span className={styles.placeholderPhase}>{t('voice.conv.phase.idle')}</span>
          <button
            type="button"
            className={styles.placeholderClose}
            onClick={() => send({ kind: 'dismiss' })}
            aria-label={t('voice.conv.close')}
            title={t('voice.conv.close')}
          >
            <X size={14} aria-hidden />
          </button>
        </section>
      </div>
    )
  }
  return (
    <div className={styles.root}>
      {drag}
      <VoiceConversationView
        embedded
        state={hud.state}
        targets={hud.targets}
        restartable={hud.restartable ?? []}
        current={hud.current ?? null}
        hint={hud.hint}
        approvalChannel={hud.approvalChannel}
        destructiveNeedsHud={hud.destructiveNeedsHud}
        rate={hud.rate}
        reducedMotion={hud.reducedMotion === true}
        onAction={send}
      />
    </div>
  )
}
