import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { getLocale, translate, useT } from '../../lib/i18n'
import { formatShortcut, isMacOS } from '../../lib/platform'
import {
  hudPlacement,
  onVoiceHudAction,
  onVoiceHudMoved,
  onVoiceShortcut,
  voiceHudHide,
  voiceHudPublish,
  voiceHudShow,
  voiceShortcutSet,
} from '../../lib/tauri'
import { VoiceConversationController } from '../../lib/voice/controller'
import { decodeHudAction, encodeHudState, type HudViewState } from '../../lib/voice/hudState'
import {
  isAcceleratorRelease,
  matchesAccelerator,
  parseAccelerator,
} from '../../lib/voice/shortcut'
import { HUD_IDLE_HIDE_MS, voiceSurface } from '../../lib/voice/surface'
import { listClaudeTargets, voiceTargetable } from '../../lib/voice/target'
import { createThrottle } from '../../lib/voice/throttle'
import { withTtsChoice } from '../../lib/voice/voicePreferences'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { type VoiceConversationAction, VoiceConversationView } from './VoiceConversationView'

const HUD_PUBLISH_MS = 100
const NOW_TICK_MS = 500

type VoiceConversationData = ReturnType<typeof useVoiceConversationStore.getState>

const voiceStore = () => useVoiceConversationStore.getState()
const isActive = (s: Pick<VoiceConversationData, 'capture' | 'turn' | 'permission' | 'notice'>) =>
  s.capture !== 'idle' || s.turn !== 'idle' || s.permission !== null || s.notice !== null
const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const shortcutLabel = (shortcut: string) =>
  formatShortcut(shortcut.replace(/CmdOrCtrl|CommandOrControl/i, 'Ctrl'))

/** Drops a Tauri listener even when it is obtained after the effect already went away. */
function listenerCleanup(pending: Promise<UnlistenFn>): () => void {
  let off: UnlistenFn | null = null
  let gone = false
  pending
    .then((unlisten) => {
      if (gone) unlisten()
      else off = unlisten
    })
    .catch(() => undefined)
  return () => {
    gone = true
    off?.()
  }
}

/** Mounted once in the main window while voice conversation is on. */
export function VoiceConversation() {
  const enabled = useProjectsStore((s) => s.preferences.voiceConversationEnabled)
  return enabled ? <VoiceConversationSession /> : null
}

function VoiceConversationSession() {
  const t = useT()
  const shortcut = useProjectsStore((s) => s.preferences.voiceShortcut)
  const captureMode = useProjectsStore((s) => s.preferences.voiceCaptureMode)
  const approvalChannel = useProjectsStore((s) => s.preferences.voiceApprovalChannel)
  const destructiveNeedsHud = useProjectsStore((s) => s.preferences.voiceDestructiveNeedsHud)
  const speechRate = useProjectsStore((s) => s.preferences.voiceTts.rate)
  const language = useProjectsStore((s) => s.preferences.language)
  const uiTheme = useProjectsStore((s) => s.preferences.uiTheme)
  const visualStyle = useProjectsStore((s) => s.preferences.visualStyle ?? 'normal')
  const projects = useProjectsStore((s) => s.projects)
  const runtime = useTerminalsStore((s) => s.byPtyId)
  const capture = useVoiceConversationStore((s) => s.capture)
  const turn = useVoiceConversationStore((s) => s.turn)
  const target = useVoiceConversationStore((s) => s.target)
  const pinnedPtyId = useVoiceConversationStore((s) => s.pinnedPtyId)
  const transcript = useVoiceConversationStore((s) => s.transcript)
  const narration = useVoiceConversationStore((s) => s.narration)
  const permission = useVoiceConversationStore((s) => s.permission)
  const notice = useVoiceConversationStore((s) => s.notice)
  const hookedPtyIds = useVoiceConversationStore((s) => s.voiceHookedPtyIds)
  const hudDismissed = useVoiceConversationStore((s) => s.hudDismissed)
  const idleSince = useVoiceConversationStore((s) => s.idleSince)
  const controllerRef = useRef<VoiceConversationController | null>(null)
  const [globalShortcut, setGlobalShortcut] = useState(false)
  const [mainFocused, setMainFocused] = useState(() => document.hasFocus())
  const [now, setNow] = useState(() => Date.now())
  const [hudAvailable, setHudAvailable] = useState(true)
  const hudWarned = useRef(false)

  useEffect(() => {
    const controller = new VoiceConversationController()
    controllerRef.current = controller
    void controller.start()
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [])

  const press = useCallback((jev: boolean) => {
    if (voiceStore().shortcutRecording) return
    voiceStore().patch({ hudDismissed: false })
    void controllerRef.current?.press({ jev })
  }, [])
  const release = useCallback(() => {
    void controllerRef.current?.release()
  }, [])

  useEffect(() => {
    let cancelled = false
    setGlobalShortcut(false)
    voiceShortcutSet(shortcut)
      .then(() => {
        if (!cancelled) setGlobalShortcut(true)
      })
      .catch(() => {
        // Only a valid shortcut in the app can be "taken"; anything else is not another app's fault.
        if (cancelled || !parseAccelerator(shortcut) || !inTauri()) return
        const locale = getLocale()
        useUiStore.getState().pushToast({
          title: translate(locale, 'voice.conv.shortcutTakenTitle'),
          body: translate(locale, 'voice.conv.shortcutTakenBody', {
            shortcut: shortcutLabel(shortcut),
          }),
        })
      })
    return () => {
      cancelled = true
      void voiceShortcutSet(null).catch(() => undefined)
    }
  }, [shortcut])

  const accelerator = useMemo(() => parseAccelerator(shortcut), [shortcut])

  // Fallback for when the OS would not register the shortcut; the global one covers it otherwise.
  useEffect(() => {
    if (!accelerator || globalShortcut) return
    const mac = isMacOS()
    const onKeyDown = (event: KeyboardEvent) => {
      // The preference recorder needs this chord to reach it.
      if (voiceStore().shortcutRecording) return
      const { matched, jev } = matchesAccelerator(event, accelerator, mac)
      if (!matched) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      press(jev)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (captureMode !== 'push-to-talk' || !isAcceleratorRelease(event, accelerator, mac)) return
      release()
    }
    // Losing focus mid-hold would leave the mic open: treat it as a release.
    const onBlur = () => {
      if (captureMode === 'push-to-talk') release()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [accelerator, captureMode, globalShortcut, press, release])

  const targets = useMemo(
    () => listClaudeTargets(projects, voiceTargetable(runtime, hookedPtyIds)),
    [projects, runtime, hookedPtyIds],
  )

  const onAction = useCallback((action: VoiceConversationAction) => {
    if (action.kind === 'rate') {
      const store = useProjectsStore.getState()
      store.setPreferences(withTtsChoice(store.preferences, { rate: action.rate }))
      return
    }
    const controller = controllerRef.current
    if (!controller) return
    if (action.kind === 'answer') void controller.answer(action.answer, action.requestId)
    else if (action.kind === 'pin') controller.pinTarget(action.ptyId)
    else if (action.kind === 'stop-speaking') controller.stopSpeaking()
    else controller.dismiss()
  }, [])

  useEffect(() => {
    const cleanups = [
      listenerCleanup(
        onVoiceShortcut(({ state, jev }) => {
          if (state === 'pressed') press(jev)
          else if (useProjectsStore.getState().preferences.voiceCaptureMode === 'push-to-talk') {
            release()
          }
        }),
      ),
      listenerCleanup(
        onVoiceHudAction((json) => {
          const action = decodeHudAction(json)
          if (!action) return
          // Only the HUD's own close button hides it until the next press.
          if (action.kind === 'dismiss') voiceStore().patch({ hudDismissed: true })
          onAction(action)
        }),
      ),
      listenerCleanup(
        onVoiceHudMoved((pos) =>
          useProjectsStore
            .getState()
            .setPreferences({ voiceHudPosition: 'custom', voiceHudCustomPosition: pos }),
        ),
      ),
      // Wrapped so a synchronous throw outside Tauri becomes a dropped rejection.
      listenerCleanup(
        Promise.resolve().then(() =>
          getCurrentWindow().onFocusChanged(({ payload }) => setMainFocused(payload)),
        ),
      ),
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [onAction, press, release])

  // A subscription rather than an effect, so `idleSince` lands in the same update that ended the
  // conversation; an effect would render once with neither and flash the HUD off and on.
  useEffect(
    () =>
      useVoiceConversationStore.subscribe((next, previous) => {
        const update: Partial<VoiceConversationData> = {}
        const nowActive = isActive(next)
        if (nowActive !== isActive(previous)) update.idleSince = nowActive ? null : Date.now()
        // A dismissed HUD must not hide a new approval.
        const card = next.permission
        if (card && card.requestId !== previous.permission?.requestId && next.hudDismissed) {
          update.hudDismissed = false
        }
        if (Object.keys(update).length > 0) next.patch(update)
      }),
    [],
  )

  useEffect(() => {
    if (idleSince === null) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current - idleSince >= HUD_IDLE_HIDE_MS) clearInterval(timer)
    }, NOW_TICK_MS)
    return () => clearInterval(timer)
  }, [idleSince])

  const label = shortcutLabel(shortcut)
  const hint =
    captureMode === 'push-to-talk'
      ? t('voice.conv.hintPushToTalk', { shortcut: label })
      : t('voice.conv.hintToggle', { shortcut: label })

  const hudView = useMemo<HudViewState>(
    () => ({
      state: { capture, turn, target, pinnedPtyId, transcript, narration, permission, notice },
      targets,
      hint,
      approvalChannel,
      destructiveNeedsHud,
      rate: speechRate,
      language,
      uiTheme,
      visualStyle,
    }),
    [
      capture,
      turn,
      target,
      pinnedPtyId,
      transcript,
      narration,
      permission,
      notice,
      targets,
      hint,
      approvalChannel,
      destructiveNeedsHud,
      speechRate,
      language,
      uiTheme,
      visualStyle,
    ],
  )

  const hudViewRef = useRef(hudView)
  useEffect(() => {
    hudViewRef.current = hudView
  }, [hudView])
  const publishNow = useCallback(() => {
    void voiceHudPublish(encodeHudState(hudViewRef.current)).catch(() => undefined)
  }, [])
  const publisherRef = useRef<ReturnType<typeof createThrottle> | null>(null)
  useEffect(() => {
    const publisher = createThrottle(HUD_PUBLISH_MS, publishNow)
    publisherRef.current = publisher
    return () => {
      publisher.dispose()
      publisherRef.current = null
    }
  }, [publishNow])

  const active = isActive({ capture, turn, permission, notice })
  const wanted = voiceSurface({ mainFocused, active, idleSince, now, dismissed: hudDismissed })
  // Without the HUD window, the in-window panel keeps the conversation visible.
  const surface = wanted === 'hud' && !hudAvailable ? 'dock' : wanted

  // Each time the HUD is wanted again it is retried, so a HUD that failed once is not lost for good.
  useEffect(() => {
    if (wanted !== 'hud') {
      void voiceHudHide().catch(() => undefined)
      return
    }
    let cancelled = false
    // Published first, so the HUD never opens on a stale snapshot.
    publishNow()
    const { voiceHudPosition, voiceHudCustomPosition } = useProjectsStore.getState().preferences
    voiceHudShow(hudPlacement(voiceHudPosition, voiceHudCustomPosition))
      .then(() => {
        if (cancelled) return
        setHudAvailable(true)
        // Changes made while it opened (or while the panel stood in after a failure) were not sent.
        publishNow()
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setHudAvailable(false)
        if (hudWarned.current) return
        hudWarned.current = true
        console.warn('voice HUD unavailable; using the in-window panel', cause)
      })
    return () => {
      cancelled = true
    }
  }, [wanted, publishNow])

  useEffect(
    () => () => {
      void voiceHudHide().catch(() => undefined)
    },
    [],
  )

  // Changes while the HUD is visible; the moment it shows is covered by the publish above.
  const shownSurface = useRef(surface)
  useEffect(() => {
    const justShown = shownSurface.current !== 'hud'
    shownSurface.current = surface
    if (surface !== 'hud' || justShown) return
    publisherRef.current?.schedule()
  }, [surface, hudView])

  if (surface !== 'dock') return null
  return (
    <VoiceConversationView
      state={hudView.state}
      targets={targets}
      hint={hint}
      approvalChannel={approvalChannel}
      destructiveNeedsHud={destructiveNeedsHud}
      rate={speechRate}
      onAction={onAction}
    />
  )
}
