import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { AgentHookPayload } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import {
  INITIAL_VOICE_CONVERSATION,
  useVoiceConversationStore,
  type VoiceNotice,
} from '../../stores/voiceConversationStore'
import { type AgentInput, agentInputFor, waitForAgentInput } from '../agentInputRegistry'
import {
  looksLikeChoicePrompt,
  PaneHiddenError,
  TerminalPromptOpenError,
} from '../agentPromptDelivery'
import { agentLabel } from '../agentProviders'
import { getLocale, translate } from '../i18n'
import { openCapture, transcribeCapture } from '../speech/capture'
import { sttChoiceFor } from '../speech/engine'
import { isSpeechTooShort } from '../speech/errors'
import {
  agentPermissionDecide,
  agentTranscriptSnapshot,
  agentVoiceHookedPtys,
  onAgentPermissionReleased,
  onTtsEnd,
  onTtsProgress,
  onTtsStart,
  readClipboardText,
  speechStopCapture,
  ttsPause,
  ttsPrefetch,
  ttsResume,
  ttsSetMuted,
  ttsSpeak,
  ttsStop,
  voiceSetTargets,
} from '../tauri'
import { cloudFailureMessage } from './cloudErrors'
import { isJevKeyConfigured } from './jevKey'
import { normalizeNarration } from './narration'
import { estimateSpeechMs, Narrator, newTranscriptEvents, type Translate } from './narrator'
import { PausableTimer } from './pausableTimer'
import {
  answerAllowed,
  describeRequest,
  isDestructive,
  parseSpokenAnswer,
  type PermissionAnswer,
} from './permissions'
import { isCloudProvider } from './providers'
import { currentSelection, registerReadAloud } from './readAloud'
import { routeTranscript } from './routing'
import { codePointLength, estimatedSpokenOffset, wordStartIn } from './spokenWords'
import { nextCapture, nextTurn } from './stateMachine'
import {
  hasVoiceHooks,
  listAgentTargets,
  resolveTarget,
  type VoiceTarget,
  voiceTargetable,
} from './target'
import { chunkForSpeech, readableTerminalText, screenReply } from './terminalText'

const TRANSCRIPT_POLL_MS = 700
/** Harnesses whose session transcript Alethe reads (`agent_transcript_snapshot`). */
const transcriptAgent = (agent: string): 'claude' | 'codex' | null =>
  agent === 'claude' || agent === 'codex' ? agent : null
/** An agent's TUI needs a moment after Esc before it takes new input. */
const INTERRUPT_SETTLE_MS = 300
const SPOKEN_SUBJECT_CHARS = 120
/**
 * Cloud and local voices synthesize after `tts_speak` returns; this bounds the wait for their
 * first audio (and for a later chunk while the player reports progress), so an event that never
 * comes cannot hold the narration forever.
 */
const TTS_START_GRACE_MS = 30_000
/** Starts that arrived before their utterance's waiter was set; only the newest few matter. */
const EARLY_STARTS_KEPT = 8
/** How often the spoken word is estimated for an engine that reports no progress. */
const SPOKEN_ESTIMATE_MS = 100
/** Main-agent events that mean Claude is past any permission dialog it was showing. */
const CLEARS_TERMINAL_PROMPT = new Set([
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
])

const store = () => useVoiceConversationStore.getState()
const prefs = () => useProjectsStore.getState().preferences
const t: Translate = (key, params) => translate(getLocale(), key, params)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** `provider` is the speech provider that failed, when known, so a cloud error reads as words. */
const failure = (cause: unknown, provider?: string): VoiceNotice => ({
  key: 'voice.conv.failed',
  params: {
    reason:
      (provider ? cloudFailureMessage(cause, provider, t) : null) ??
      (cause instanceof Error ? cause.message : String(cause)),
  },
})

/**
 * Runs in the main window, where the stores and PTYs are. The view only renders
 * `voiceConversationStore` and calls these methods.
 */
export class VoiceConversationController {
  private unlisteners: UnlistenFn[] = []
  private narrator: Narrator
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollInFlight: Promise<void> | null = null
  /** Bumped whenever a turn begins or ends, so a poll that outlived its turn is discarded. */
  private generation = 0
  /** The pane the transcript cursor belongs to; set together with the cursor. */
  private pollTarget: VoiceTarget | null = null
  private revision: number | null = null
  private cursor: number | null = null
  /** The last assistant text the transcript gave this turn; the reply when no Stop hook says it. */
  private lastAssistantText = ''
  /**
   * For a harness without hooks: its terminal text when the prompt was sent, and the prompt.
   * The reply is what its screen shows past them once its output goes quiet.
   */
  private screenTurn: { before: string; prompt: string } | null = null
  private jevPending = false
  private starting = false
  private releaseAfterStart = false
  private disposed = false
  /** A panel answer is being sent; a second click must not answer whatever card comes next. */
  private deciding = false
  /** The voice-hooked PTY refresh started by the last press; a send waits for it. */
  private hookedRefresh: Promise<void> = Promise.resolve()
  /** The card shown when the person started talking: only that card can take the answer. */
  private pressCardId: string | null = null
  private ttsUnavailable = false
  /** Why the wait for an utterance ended: its end event, its estimate running out, or a cut. */
  private endWaiters = new Map<number, (reason: 'end' | 'timer' | 'cut') => void>()
  private startWaiters = new Map<number, () => void>()
  private earlyStarts = new Set<number>()
  /** Bumped when the wait for an utterance is cut short, so a speak still starting gives up. */
  private speechToken = 0
  /** The player holds the utterance in flight (pause); its timer must not run meanwhile. */
  private speechHeld = false
  private speechTimer: PausableTimer | null = null
  /** A mute toggle is on its way to Rust. */
  private muting = false
  /** The utterance in flight, when it became audible and how long it is estimated to last. */
  private speechId: number | null = null
  private speechStartedAt: number | null = null
  private speechEstimate = 0
  /** Time the utterance in flight spent held (paused), and since when it is held now. */
  private speechHeldMs = 0
  private speechHeldAt: number | null = null
  /**
   * The utterance in flight as the panel shows it: the item shown, split in code points, where
   * the utterance starts in it (a resumed sentence starts past it) and how long it is. `exact`:
   * the player reports its progress, so the estimate stands down.
   */
  private spokenSpan: {
    id: number
    shown: string[]
    base: number
    length: number
    exact: boolean
  } | null = null
  private spokenTimer: ReturnType<typeof setInterval> | null = null
  /**
   * PTYs where Claude is showing its own permission dialog. The voice submit ends in one Enter,
   * which would approve that dialog, so nothing is sent to them until Claude moves on.
   */
  private terminalPrompts = new Set<string>()
  /** Every held request seen (card or auto-deferred) and its PTY, until decided or released. */
  private heldRequests = new Map<string, string>()

  constructor() {
    this.narrator = new Narrator({
      speak: (text, shown) => this.speak(text, shown),
      stop: () => this.stopSpeech(),
      skip: () => this.endSpeechWait(),
      prefetch: (text) => this.prefetch(text),
      pauseSpeech: () => this.holdSpeech(true),
      resumeSpeech: () => this.holdSpeech(false),
      // The system voice cannot hold an utterance; cloud and local voices play through the player.
      restartsOnPause: () => prefs().voiceTts.provider === 'system',
      progress: () => this.speechProgress(),
      onPausedChange: (paused) => store().patch({ narrationPaused: paused }),
      onActiveChange: (active) => store().patch({ narrationActive: active }),
      t,
      // Cloud sync writes the toggles as it got them.
      narration: () => normalizeNarration(prefs().voiceNarration, undefined),
      fillAfterMs: () => prefs().voiceFillAfterMs,
    })
  }

  async start(): Promise<void> {
    // The store's mute outlives this controller (and Rust's outlives a webview reload): agree.
    void ttsSetMuted(store().muted).catch(() => undefined)
    // A pause does not survive the narrator that held it (a webview reload).
    void ttsResume().catch(() => undefined)
    // Rust keeps the targets across a webview reload; requests would be held for nobody.
    await voiceSetTargets([]).catch(() => undefined)
    if (this.disposed) return
    await this.refreshHookedPtys()
    // Disposed meanwhile (StrictMode remounts in dev): a listener obtained late is dropped at once.
    const subscriptions = [
      () => listen<AgentHookPayload>('agent-hook', (event) => this.onHook(event.payload)),
      () => onAgentPermissionReleased((event) => this.onReleased(event.requestId)),
      () =>
        onTtsEnd((id) => {
          if (!this.disposed) this.endWaiters.get(id)?.('end')
        }),
      () => onTtsStart((id) => this.onTtsStarted(id)),
      () => onTtsProgress((id, charOffset) => this.onTtsProgress(id, charOffset)),
    ]
    for (const subscribe of subscriptions) {
      if (this.disposed) return
      const off = await subscribe()
      if (this.disposed) {
        off()
        return
      }
      this.unlisteners.push(off)
    }
    this.unlisteners.push(
      useUiStore.subscribe((ui, previous) => {
        if (ui.activeTerminal?.terminalId === previous.activeTerminal?.terminalId) return
        const active = this.targets().find(
          (item) => item.tabActive && item.terminalId === ui.activeTerminal?.terminalId,
        )
        if (active) store().patch({ lastAgentPtyId: active.ptyId })
      }),
      useTerminalsStore.subscribe((terminals, previous) => {
        this.checkTargetAlive()
        this.checkTurnQuiet(terminals.byPtyId, previous.byPtyId)
      }),
      registerReadAloud((text) => this.readAloud(text)),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.unlisteners) off()
    this.unlisteners = []
    this.stopPolling()
    this.stopSpokenEstimate()
    this.narrator.dispose()
    if (store().capture === 'listening' || this.starting) {
      void speechStopCapture().catch(() => undefined)
    }
    store().patch({
      ...INITIAL_VOICE_CONVERSATION,
      pinnedPtyId: store().pinnedPtyId,
      muted: store().muted,
    })
    void voiceSetTargets([]).catch(() => undefined)
  }

  async press(options: { jev: boolean }): Promise<void> {
    if (this.disposed) return
    // A pane launched since the last press may carry the voice hooks now.
    this.hookedRefresh = this.refreshHookedPtys()
    if (store().capture === 'listening') {
      if (prefs().voiceCaptureMode === 'toggle') await this.release()
      return
    }
    if (this.disposed || store().capture !== 'idle' || this.starting) return
    // Held, not discarded: a press that ends up sending nothing (a stray tap, silence, a failure)
    // leaves the narration paused to resume. Only a sent transcript drops it (see `release`).
    this.narrator.pause()
    this.starting = true
    this.releaseAfterStart = false
    this.pressCardId = store().permission?.requestId ?? null
    try {
      const p = prefs()
      const engine = sttChoiceFor(p, 'conversation')
      const block = await openCapture(engine, p.dictationMicrophoneId, {
        prepareLocal: true,
        // The controller may go away while the mic is opening; nobody would ever close it.
        cancelled: () => this.disposed,
      })
      if (block) {
        if (block !== 'cancelled') store().patch({ notice: { key: block } })
        return
      }
      this.jevPending = options.jev
      store().patch({
        capture: nextCapture(store().capture, 'press'),
        notice: null,
        transcript: '',
      })
    } catch (cause) {
      store().patch({ notice: failure(cause) })
    } finally {
      this.starting = false
    }
    if (this.releaseAfterStart && !this.disposed) await this.release()
  }

  async release(): Promise<void> {
    if (this.disposed) return
    if (this.starting) {
      this.releaseAfterStart = true
      return
    }
    if (store().capture !== 'listening') return
    store().patch({ capture: nextCapture('listening', 'captured') })
    let text: string
    const engine = sttChoiceFor(prefs(), 'conversation')
    try {
      text = await transcribeCapture(engine, 'conversation')
    } catch (cause) {
      store().patch({
        capture: nextCapture('transcribing', 'failed'),
        // A quick tap of the shortcut, not a failure: say how to use it.
        notice: isSpeechTooShort(cause)
          ? { key: 'voice.conv.holdHint' }
          : failure(cause, engine.provider),
      })
      return
    }
    if (this.disposed) return
    if (!text) {
      store().patch({
        capture: nextCapture('transcribing', 'nothing'),
        notice: { key: 'voice.conv.heardNothing' },
      })
      return
    }
    store().patch({ capture: nextCapture('transcribing', 'transcribed'), transcript: text })
    this.narrator.stop()
    try {
      await this.handleTranscript(text)
    } catch (cause) {
      store().patch({ notice: failure(cause) })
    } finally {
      store().patch({ capture: nextCapture('sending', 'done') })
    }
  }

  /** An answer clicked on the panel, for the card with `requestId`; refused if another shows now. */
  async answer(answer: PermissionAnswer, requestId: string): Promise<void> {
    if (store().permission?.requestId !== requestId) return
    await this.decide(answer, 'hud')
  }

  /** Talks to `ptyId` from now on and brings it to front; `null` follows the active pane again. */
  pinTarget(ptyId: string | null): void {
    store().patch({ pinnedPtyId: ptyId })
    const picked = ptyId ? this.targets().find((item) => item.ptyId === ptyId) : undefined
    // Shown at once, so its terminal is mounted and streaming by the time the person speaks.
    if (picked) this.showTarget(picked)
  }

  /** Discards the rest of the narration (and any pause). */
  stopSpeaking(): void {
    this.narrator.stop()
  }

  /** Narration goes on at the same pace with no sound, or with sound again. */
  async toggleMute(): Promise<void> {
    // One toggle at a time: a second click before Rust answered would flip from a stale value.
    if (this.muting) return
    this.muting = true
    const muted = !store().muted
    try {
      await ttsSetMuted(muted)
    } catch {
      // Rust did not take it: the button keeps showing what is really heard.
      return
    } finally {
      this.muting = false
    }
    store().patch({ muted })
    // The system voice takes its volume per utterance: say the rest again, from the sentence reached.
    if (!this.disposed) this.narrator.restartSentence()
  }

  /** Pause holds narration in progress; with nothing speaking or queued it does nothing. */
  togglePause(): void {
    if (this.narrator.isPaused()) this.narrator.resume()
    else this.narrator.pause()
  }

  dismiss(): void {
    store().patch({ notice: null, transcript: '', narration: '', narrationSpokenOffset: null })
  }

  private targets(): VoiceTarget[] {
    return listAgentTargets(
      useProjectsStore.getState().projects,
      voiceTargetable(useTerminalsStore.getState().byPtyId, store().voiceHookedPtyIds),
    )
  }

  private async refreshHookedPtys(): Promise<void> {
    try {
      const ids = await agentVoiceHookedPtys()
      if (!this.disposed) store().patch({ voiceHookedPtyIds: ids })
    } catch {
      // Keeps the last known set.
    }
  }

  /**
   * Shows the target pane the way the voice command bar does, with its agent tab in front, so its
   * terminal mounts and its PTY streams again.
   */
  private showTarget(target: VoiceTarget): void {
    const projects = useProjectsStore.getState()
    projects.setActiveProjectOnly(target.projectId)
    projects.setActiveTab(target.projectId, target.terminalId, target.tabId)
    projects.focusWorkspaceTerminal(target.projectId, target.terminalId)
    const ui = useUiStore.getState()
    ui.setActiveTerminal(target.projectId, target.terminalId)
    ui.requestPaneFocus(target.terminalId)
  }

  private currentTarget(): VoiceTarget | null {
    return resolveTarget(this.targets(), {
      pinnedPtyId: store().pinnedPtyId,
      activeTerminalId: useUiStore.getState().activeTerminal?.terminalId ?? null,
      lastAgentPtyId: store().lastAgentPtyId,
    })
  }

  private async handleTranscript(text: string): Promise<void> {
    const card = store().permission
    if ((card?.requestId ?? null) !== this.pressCardId) {
      // A card appeared, changed or went away while the person spoke: the words did not answer it.
      // When it went away, its own notice (released, answered) stays and the transcript is kept.
      if (card) store().patch({ notice: { key: 'voice.conv.answerUnclear' } })
      return
    }
    if (card) {
      const answer = parseSpokenAnswer(text)
      if (answer.kind === 'unclear') {
        store().patch({ notice: { key: 'voice.conv.answerUnclear' } })
        return
      }
      await this.decide(answer, 'voice')
      store().patch({ transcript: '' })
      return
    }
    const p = prefs()
    const route = routeTranscript(text, {
      jevTrigger: p.voiceJevTrigger,
      interruptWords: p.voiceInterruptWords,
      midTaskDefault: p.voiceMidTaskDefault,
      busy: store().turn !== 'idle',
      jevModifier: this.jevPending,
    })
    if (route.kind === 'empty') return
    if (route.kind === 'jev') {
      if (!isJevKeyConfigured(p.voiceProviders)) {
        store().patch({ notice: { key: 'voice.conv.jevNotConfigured' } })
        // The bar is where the key is entered.
        useUiStore.getState().openVoiceCommand('')
        return
      }
      useUiStore.getState().openVoiceCommand(route.text)
      store().patch({ transcript: '' })
      return
    }
    await this.send(route.text, route.interrupt)
  }

  private async send(text: string, interrupt: boolean): Promise<void> {
    await this.hookedRefresh
    let target = this.currentTarget()
    let input = target ? agentInputFor(target.ptyId) : null
    if (!target || !input) {
      // The pane may have respawned between capture and send.
      target = this.currentTarget()
      input = target ? agentInputFor(target.ptyId) : null
    }
    if (!target) {
      store().patch({
        notice: { key: 'voice.conv.noTarget', params: { trigger: prefs().voiceJevTrigger } },
      })
      return
    }
    if (!input) {
      // A live session with no terminal mounted sits in a background tab or a hidden pane.
      this.showTarget(target)
      input = await this.waitForInput(target.ptyId)
      if (!input) {
        store().patch({ notice: { key: 'voice.conv.targetHidden' } })
        return
      }
    }
    if (this.terminalPrompts.has(target.ptyId)) {
      store().patch({ notice: { key: 'voice.conv.terminalPromptOpen' } })
      return
    }
    if (interrupt) {
      await input.interrupt()
      await sleep(INTERRUPT_SETTLE_MS)
    }
    if (!text) {
      store().patch({ transcript: '' })
      // No Stop hook runs after an interrupt, so the turn the Esc cut short ends here.
      if (interrupt && this.isTurnTarget(target.ptyId)) {
        this.stopPolling()
        this.narrator.endTurn()
        await this.closeTurn()
      }
      return
    }
    const midTurn = store().turn !== 'idle' && store().target?.ptyId === target.ptyId
    if (!midTurn) await this.beginTurn(target, input, text)
    // Held before the Enter, so a permission request the prompt triggers at once is held too.
    // Only Claude's hooks hold requests; another harness asks in its terminal.
    await voiceSetTargets(hasVoiceHooks(target.agent) ? [target.ptyId] : [])
    try {
      await input.submit(text)
    } catch (cause) {
      if (!midTurn) await this.abandonTurn()
      if (cause instanceof PaneHiddenError) {
        this.showTarget(target)
        store().patch({ notice: { key: 'voice.conv.targetHidden' } })
        return
      }
      if (!(cause instanceof TerminalPromptOpenError)) throw cause
      // Not added to `terminalPrompts`: the screen is read again on every submit, so a false
      // positive (a "1. Yes" line in Claude's reply) clears itself once it scrolls away.
      store().patch({ notice: { key: 'voice.conv.terminalPromptOpen' } })
      return
    }
    store().patch({ target, turn: nextTurn(store().turn, 'sent'), transcript: '' })
    this.startPolling()
  }

  /** The input of a session just brought to front; null when a turn began or ended meanwhile. */
  private waitForInput(ptyId: string): Promise<AgentInput | null> {
    const generation = this.generation
    return waitForAgentInput(ptyId, () => !this.disposed && generation === this.generation)
  }

  /** Undoes `beginTurn` + targeting for a prompt that was never submitted. */
  private async abandonTurn(): Promise<void> {
    this.generation += 1
    this.pollTarget = null
    this.cursor = null
    const running = store().turn !== 'idle' ? store().target : null
    await voiceSetTargets(running ? [running.ptyId] : []).catch(() => undefined)
  }

  /**
   * Marks where this turn starts in the transcript, so narration never re-reads an older turn,
   * and keeps the screen as it was for a harness without hooks (see `screenTurn`).
   */
  private async beginTurn(target: VoiceTarget, input: AgentInput, prompt: string): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.pollTarget = null
    this.revision = null
    this.cursor = null
    this.lastAssistantText = ''
    this.screenTurn = hasVoiceHooks(target.agent) ? null : { before: input.readScreen(), prompt }
    const provider = transcriptAgent(target.agent)
    if (!provider) {
      this.narrator.beginTurn()
      return
    }
    try {
      const snapshot = await agentTranscriptSnapshot(provider, target.cwd, target.sessionId, null)
      if (generation === this.generation) {
        this.cursor = snapshot.firstIndex + snapshot.messages.length
        this.revision = snapshot.revision
        this.pollTarget = target
      }
    } catch {
      // No transcript: intermediate narration stays off this turn; the final answer still comes
      // from the Stop hook (Claude) or the screen (any other harness).
    }
    this.narrator.beginTurn()
  }

  private onHook(payload: AgentHookPayload): void {
    if (this.disposed) return
    if (payload.sourceAgent && payload.sourceAgent !== 'claude') return
    const ptyId = payload.plannerId
    if (!ptyId) return
    const event = payload.hook_event_name ?? ''
    // A subagent's permission dialog shows in the same terminal, so it counts too.
    if (event === 'PermissionRequest') {
      this.onPermission(ptyId, payload)
      return
    }
    if (payload.agent_id) return
    // Tracked whatever the turn, so a dialog Claude opened outside a voice turn still blocks sends.
    if (CLEARS_TERMINAL_PROMPT.has(event)) this.terminalPrompts.delete(ptyId)
    if (!this.isTurnTarget(ptyId)) return
    switch (event) {
      case 'PreToolUse':
        this.narrator.onToolStart({ tool_name: payload.tool_name, tool_input: payload.tool_input })
        break
      case 'PostToolUse':
        this.narrator.onToolEnd()
        break
      case 'Stop':
        void this.endTurn(payload.last_assistant_message ?? '')
        break
    }
  }

  private isTurnTarget(ptyId: string): boolean {
    return store().target?.ptyId === ptyId && store().turn !== 'idle'
  }

  private onPermission(ptyId: string, payload: AgentHookPayload): void {
    const requestId = payload.permissionRequestId
    if (!requestId) {
      // Not held by Alethe: Claude is asking in the terminal.
      this.terminalPrompts.add(ptyId)
      return
    }
    this.heldRequests.set(requestId, ptyId)
    if (!this.isTurnTarget(ptyId) || store().permission) {
      // Held, but no card can show it: hand it back now rather than at the hold deadline.
      this.handBack(requestId)
      void agentPermissionDecide(requestId, 'defer').catch(() => undefined)
      return
    }
    const described = describeRequest(payload)
    const tool = described.tool ?? t('voice.conv.unknownTool')
    const subject = described.subject
    const destructive = isDestructive(payload)
    store().patch({
      permission: { requestId, tool, subject, destructive },
      turn: nextTurn(store().turn, 'permission'),
    })
    if (prefs().voiceApprovalChannel !== 'hud') {
      this.narrator.announce(
        t('voice.conv.permissionAsk', { tool, subject: subject.slice(0, SPOKEN_SUBJECT_CHARS) }),
      )
    }
  }

  private async decide(answer: PermissionAnswer, source: 'voice' | 'hud'): Promise<void> {
    const card = store().permission
    if (!card || this.deciding) return
    const p = prefs()
    const options = {
      channel: p.voiceApprovalChannel,
      destructiveNeedsHud: p.voiceDestructiveNeedsHud,
    }
    if (!answerAllowed(answer, card.destructive, options, source)) {
      store().patch({ notice: { key: 'voice.conv.voiceApprovalBlocked' } })
      return
    }
    const behavior = answer.kind
    // The card may have been released, and another shown, while the answer was on its way.
    const stillShown = () => store().permission?.requestId === card.requestId
    this.deciding = true
    try {
      await agentPermissionDecide(
        card.requestId,
        behavior,
        answer.kind === 'deny' ? answer.message : undefined,
      )
      if (behavior === 'defer') this.handBack(card.requestId)
      else this.heldRequests.delete(card.requestId)
      if (stillShown()) {
        store().patch({ permission: null, notice: null, turn: nextTurn(store().turn, 'answered') })
      }
    } catch {
      // Already released (deadline, pane closed): Claude is asking in the terminal.
      this.handBack(card.requestId)
      if (stillShown()) {
        store().patch({
          permission: null,
          notice: { key: 'voice.conv.permissionReleased' },
          turn: nextTurn(store().turn, 'answered'),
        })
      }
    } finally {
      this.deciding = false
    }
  }

  private onReleased(requestId: string): void {
    if (this.disposed) return
    this.handBack(requestId)
    if (store().permission?.requestId !== requestId) return
    store().patch({
      permission: null,
      notice: { key: 'voice.conv.permissionReleased' },
      turn: nextTurn(store().turn, 'answered'),
    })
  }

  /** A held request went back to Claude, which now asks in that PTY's terminal. */
  private handBack(requestId: string): void {
    const ptyId = this.heldRequests.get(requestId)
    this.heldRequests.delete(requestId)
    if (ptyId) this.terminalPrompts.add(ptyId)
  }

  private async endTurn(finalText: string): Promise<void> {
    this.stopPolling()
    // A poll already in flight may hold this turn's last text; then one more read for the rest.
    if (this.pollInFlight) await this.pollInFlight
    await this.pollTranscript()
    const reply = finalText || this.lastAssistantText
    const screen = reply ? null : this.screenAnswer()
    await this.narrator.onStop(screen?.text ?? reply, screen?.category)
    await this.closeTurn()
  }

  /**
   * The reply of a harness without hooks, read off its screen; when the screen ends on one of its
   * own choice menus, a line saying it is asking there instead (the menu is answered in the pane).
   */
  private screenAnswer(): { text: string; category: 'final' | 'permissions' } {
    const turn = this.screenTurn
    const target = store().target
    const screen = turn && target ? agentInputFor(target.ptyId)?.readScreen() : ''
    if (!turn || !target || !screen) return { text: '', category: 'final' }
    const agent = agentLabel(target.agent)
    if (looksLikeChoicePrompt(screen.split('\n').slice(-30).join('\n'))) {
      return { text: t('voice.conv.agentAsksInTerminal', { agent }), category: 'permissions' }
    }
    return { text: screenReply(turn.before, screen, turn.prompt), category: 'final' }
  }

  /**
   * A harness without hooks has no Stop: its turn ends when its completion monitor sees the
   * output go quiet (`working` → `waiting`).
   */
  private checkTurnQuiet(
    now: Record<string, { status?: string } | undefined>,
    before: Record<string, { status?: string } | undefined>,
  ): void {
    const target = store().target
    if (!target || hasVoiceHooks(target.agent) || store().turn === 'idle') return
    if (before[target.ptyId]?.status !== 'working') return
    if (now[target.ptyId]?.status !== 'waiting') return
    void this.endTurn('')
  }

  /**
   * The read-aloud shortcut: the focused terminal's selection (its own, or one its TUI copied),
   * else whatever is on the clipboard.
   */
  async readSelectionAloud(): Promise<void> {
    if (this.disposed) return
    let text = currentSelection()
    if (!text.trim()) text = await readClipboardText().catch(() => '')
    if (this.disposed) return
    if (!readableTerminalText(text)) {
      store().patch({ hudDismissed: false, notice: { key: 'voice.conv.nothingToRead' } })
      return
    }
    this.readAloud(text)
  }

  /** Reads text the person picked (a terminal selection) through the narration voice. */
  readAloud(text: string): void {
    if (this.disposed) return
    const parts = chunkForSpeech(readableTerminalText(text))
    if (parts.length === 0) return
    // Shown again even if the HUD was closed: the person asked for it.
    store().patch({ hudDismissed: false, notice: null })
    this.narrator.read(parts)
  }

  private async closeTurn(): Promise<void> {
    this.generation += 1
    this.pollTarget = null
    this.screenTurn = null
    // Untargeting first lets Rust's release of a still-held request find it in `heldRequests`.
    await voiceSetTargets([]).catch(() => undefined)
    const card = store().permission
    if (card) this.handBack(card.requestId)
    store().patch({ turn: nextTurn(store().turn, 'stopped'), permission: null })
  }

  private checkTargetAlive(): void {
    const target = store().target
    if (!target || store().turn === 'idle') return
    if (useTerminalsStore.getState().byPtyId[target.ptyId]?.alive) return
    this.stopPolling()
    this.narrator.endTurn()
    this.generation += 1
    this.pollTarget = null
    this.screenTurn = null
    this.terminalPrompts.delete(target.ptyId)
    for (const [requestId, ptyId] of this.heldRequests) {
      if (ptyId === target.ptyId) this.heldRequests.delete(requestId)
    }
    store().patch({ turn: nextTurn(store().turn, 'reset'), permission: null, target: null })
    void voiceSetTargets([]).catch(() => undefined)
  }

  private startPolling(): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setInterval(() => void this.pollTranscript(), TRANSCRIPT_POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** One transcript read at a time; a caller arriving mid-read shares it. */
  private pollTranscript(): Promise<void> {
    this.pollInFlight ??= this.readTranscript().finally(() => {
      this.pollInFlight = null
    })
    return this.pollInFlight
  }

  private async readTranscript(): Promise<void> {
    const target = this.pollTarget
    if (!target || this.cursor === null) return
    const generation = this.generation
    try {
      const fresh = this.targets().find((item) => item.ptyId === target.ptyId) ?? target
      const provider = transcriptAgent(fresh.agent)
      if (!provider) return
      const snapshot = await agentTranscriptSnapshot(
        provider,
        fresh.cwd,
        fresh.sessionId,
        this.revision,
      )
      // The turn ended or another began meanwhile: this read belongs to neither.
      if (generation !== this.generation || this.cursor === null) return
      this.revision = snapshot.revision
      if (snapshot.unchanged) return
      const next = newTranscriptEvents(snapshot, this.cursor)
      this.cursor = next.cursor
      const texts = next.events.filter((event) => event.role === 'assistant')
      this.lastAssistantText = texts[texts.length - 1]?.text ?? this.lastAssistantText
      // Claude's tool calls come from its hooks; Codex has only its transcript.
      this.narrator.onTranscript(next.events, { tools: !hasVoiceHooks(fresh.agent) })
    } catch {
      // An unreadable transcript only costs intermediate narration.
    }
  }

  /** Speaks `text`; the panel shows `shown`, the whole item a sentence may belong to. */
  private async speak(text: string, shown = text): Promise<void> {
    // A resumed sentence is the tail of the item: the highlight starts where it sits in it.
    const shownChars = Array.from(shown)
    const base = shown.endsWith(text) ? shownChars.length - codePointLength(text) : 0
    // No word is highlighted until the utterance is heard.
    store().patch({ narration: shown, narrationSpokenOffset: null })
    if (this.ttsUnavailable) return
    const choice = prefs().voiceTts
    const estimate = estimateSpeechMs(text, choice.rate)
    const token = ++this.speechToken
    try {
      const id = await ttsSpeak(text, choice)
      // Stopped or skipped while the engine was answering: nothing to wait for.
      if (token !== this.speechToken) return
      this.speechId = id
      this.speechStartedAt = Date.now()
      this.speechEstimate = estimate
      this.speechHeldMs = 0
      this.speechHeldAt = this.speechHeld ? Date.now() : null
      this.spokenSpan = {
        id,
        shown: shownChars,
        base,
        length: codePointLength(text),
        exact: false,
      }
      await new Promise<void>((resolve) => {
        // Frozen while the player holds the utterance, so a pause does not run out the estimate.
        const timer = new PausableTimer(() => done('timer'), this.speechHeld)
        this.speechTimer = timer
        const done = (reason: 'end' | 'timer' | 'cut') => {
          timer.clear()
          if (this.speechTimer === timer) this.speechTimer = null
          if (this.speechId === id) {
            this.speechId = null
            this.speechStartedAt = null
          }
          const span = this.spokenSpan
          if (span?.id === id) {
            this.stopSpokenEstimate()
            this.spokenSpan = null
            // Said to the end: all of it shows as spoken. Cut short, the highlight stays put. A
            // player that reports progress may still be playing when the estimate runs out, so
            // only its end event counts then.
            if (reason === 'end' || (reason === 'timer' && !span.exact)) {
              store().patch({ narrationSpokenOffset: span.shown.length })
            }
          }
          this.endWaiters.delete(id)
          this.startWaiters.delete(id)
          resolve()
        }
        this.endWaiters.set(id, done)
        // The system voice speaks as soon as it is asked; the others only once synthesized.
        if (choice.provider === 'system' || this.earlyStarts.delete(id)) {
          timer.arm(estimate)
          this.startSpokenEstimate(choice.rate)
          return
        }
        timer.arm(estimate + TTS_START_GRACE_MS)
        this.startWaiters.set(id, () => {
          this.startWaiters.delete(id)
          timer.arm(estimate)
          this.startSpokenEstimate(choice.rate)
        })
      })
    } catch {
      this.ttsUnavailable = true
      store().patch({
        notice: { key: 'voice.conv.ttsUnavailable' },
        narrationSpokenOffset: null,
      })
    }
  }

  private onTtsStarted(id: number): void {
    if (this.disposed) return
    // Audible from now: the share spoken counts from here, not from the request.
    if (id === this.speechId) {
      this.speechStartedAt = Date.now()
      this.speechHeldMs = 0
      this.speechHeldAt = this.speechHeld ? Date.now() : null
    }
    const waiter = this.startWaiters.get(id)
    if (waiter) {
      waiter()
      return
    }
    // `tts_speak` has not returned this id yet.
    if (this.earlyStarts.size >= EARLY_STARTS_KEPT) this.earlyStarts.clear()
    this.earlyStarts.add(id)
  }

  /**
   * The player's own position in the utterance in flight; from then on it replaces the estimate.
   * A player that reports is alive: the utterance's timer is pushed out to what is left of it,
   * plus room for a chunk still being synthesized, so a voice slower than the estimate is never
   * cut off by the next item.
   */
  private onTtsProgress(id: number, charOffset: number): void {
    const span = this.spokenSpan
    if (this.disposed || !span || span.id !== id) return
    span.exact = true
    this.stopSpokenEstimate()
    const reached = Math.min(span.length, Math.max(0, charOffset))
    this.setSpokenOffset(span, span.base + reached)
    const left = span.length > 0 ? 1 - reached / span.length : 0
    this.speechTimer?.arm(this.speechEstimate * left + TTS_START_GRACE_MS)
  }

  /** Cloud voices only: local and system voices start without a network round trip. */
  private prefetch(text: string): void {
    const choice = prefs().voiceTts
    if (this.ttsUnavailable || !isCloudProvider(choice.provider)) return
    void ttsPrefetch(text, choice).catch(() => undefined)
  }

  /** Estimates the spoken word from the speaking time until the engine reports its own. */
  private startSpokenEstimate(rate: number): void {
    this.stopSpokenEstimate()
    const span = this.spokenSpan
    if (!span || span.exact) return
    // Heard from now: its first word is the current one.
    this.setSpokenOffset(span, span.base)
    this.spokenTimer = setInterval(() => {
      if (span !== this.spokenSpan || span.exact || this.speechStartedAt === null) return
      const reached = estimatedSpokenOffset(this.speakingMs(), rate, span.length)
      this.setSpokenOffset(span, span.base + reached)
    }, SPOKEN_ESTIMATE_MS)
  }

  private stopSpokenEstimate(): void {
    if (this.spokenTimer !== null) clearInterval(this.spokenTimer)
    this.spokenTimer = null
  }

  /** Stores the start of the word `offset` falls in, so the panel updates once a word. */
  private setSpokenOffset(span: { shown: string[] }, offset: number): void {
    const word = wordStartIn(span.shown, offset)
    if (store().narrationSpokenOffset !== word) store().patch({ narrationSpokenOffset: word })
  }

  /** How long the utterance in flight has been heard, its held (paused) time left out. */
  private speakingMs(): number {
    if (this.speechStartedAt === null) return 0
    const now = Date.now()
    const held = this.speechHeldMs + (this.speechHeldAt === null ? 0 : now - this.speechHeldAt)
    return Math.max(0, now - this.speechStartedAt - held)
  }

  private stopSpeech(): void {
    // Rust drops its pause with the audio.
    this.speechHeld = false
    void ttsStop().catch(() => undefined)
    this.endSpeechWait()
  }

  /** Share of the utterance in flight already spoken, by its estimate; 0 when none is. */
  private speechProgress(): number {
    if (this.speechStartedAt === null || this.speechEstimate <= 0) return 0
    return this.speakingMs() / this.speechEstimate
  }

  /** Releases whoever waits for the utterance in flight, without touching the engine. */
  private endSpeechWait(): void {
    this.speechToken += 1
    for (const done of [...this.endWaiters.values()]) done('cut')
  }

  private holdSpeech(hold: boolean): void {
    if (hold && this.speechHeldAt === null) this.speechHeldAt = Date.now()
    if (!hold && this.speechHeldAt !== null) {
      this.speechHeldMs += Date.now() - this.speechHeldAt
      this.speechHeldAt = null
    }
    this.speechHeld = hold
    if (hold) {
      void ttsPause().catch(() => undefined)
      this.speechTimer?.pause()
    } else {
      void ttsResume().catch(() => undefined)
      this.speechTimer?.resume()
    }
  }
}
