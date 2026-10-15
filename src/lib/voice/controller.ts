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
import { agentInputFor } from '../agentInputRegistry'
import { PaneHiddenError, TerminalPromptOpenError } from '../agentPromptDelivery'
import { getLocale, translate } from '../i18n'
import { sttChoiceFor } from '../speech/engine'
import {
  agentPermissionDecide,
  agentTranscriptSnapshot,
  agentVoiceHookedPtys,
  onAgentPermissionReleased,
  onTtsEnd,
  onTtsStart,
  speechPrepare,
  speechStartCapture,
  speechStopAndTranscribe,
  speechStopCapture,
  ttsSpeak,
  ttsStop,
  voiceSetTargets,
} from '../tauri'
import { cloudFailureMessage } from './cloudErrors'
import { estimateSpeechMs, Narrator, newAssistantTexts, type Translate } from './narrator'
import {
  answerAllowed,
  describeRequest,
  isDestructive,
  parseSpokenAnswer,
  type PermissionAnswer,
} from './permissions'
import { isCloudProvider } from './providers'
import { routeTranscript } from './routing'
import { nextCapture, nextTurn } from './stateMachine'
import { listClaudeTargets, resolveTarget, type VoiceTarget, voiceTargetable } from './target'

const TRANSCRIPT_POLL_MS = 700
/** Claude's TUI needs a moment after Esc before it takes new input. */
const INTERRUPT_SETTLE_MS = 300
const SPOKEN_SUBJECT_CHARS = 120
/**
 * Cloud and local voices synthesize after `tts_speak` returns; this bounds the wait for their
 * first audio, so a start event that never comes cannot hold the narration forever.
 */
const TTS_START_GRACE_MS = 30_000
/** Starts that arrived before their utterance's waiter was set; only the newest few matter. */
const EARLY_STARTS_KEPT = 8
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
  private lastClaudePtyId: string | null = null
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
  private endWaiters = new Map<number, () => void>()
  private startWaiters = new Map<number, () => void>()
  private earlyStarts = new Set<number>()
  /**
   * PTYs where Claude is showing its own permission dialog. The voice submit ends in one Enter,
   * which would approve that dialog, so nothing is sent to them until Claude moves on.
   */
  private terminalPrompts = new Set<string>()
  /** Every held request seen (card or auto-deferred) and its PTY, until decided or released. */
  private heldRequests = new Map<string, string>()

  constructor() {
    this.narrator = new Narrator({
      speak: (text) => this.speak(text),
      stop: () => this.stopSpeech(),
      t,
      verbosity: () => prefs().voiceVerbosity,
      fillAfterMs: () => prefs().voiceFillAfterMs,
    })
  }

  async start(): Promise<void> {
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
          if (!this.disposed) this.endWaiters.get(id)?.()
        }),
      () => onTtsStart((id) => this.onTtsStarted(id)),
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
          (item) => item.terminalId === ui.activeTerminal?.terminalId,
        )
        if (active) this.lastClaudePtyId = active.ptyId
      }),
      useTerminalsStore.subscribe(() => this.checkTargetAlive()),
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.unlisteners) off()
    this.unlisteners = []
    this.stopPolling()
    this.narrator.dispose()
    if (store().capture === 'listening' || this.starting) {
      void speechStopCapture().catch(() => undefined)
    }
    store().patch({ ...INITIAL_VOICE_CONVERSATION, pinnedPtyId: store().pinnedPtyId })
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
    this.narrator.stop()
    this.starting = true
    this.releaseAfterStart = false
    this.pressCardId = store().permission?.requestId ?? null
    try {
      const p = prefs()
      const engine = sttChoiceFor(p, 'conversation')
      if (engine.needsLocale) {
        store().patch({ notice: { key: 'speech.nativeLocaleRequired' } })
        return
      }
      // Awaited directly, not through `.catch`, so the mic opens as soon as the model is ready.
      let ready: boolean
      try {
        ready = await speechPrepare(engine.modelId, engine.locale, engine.provider)
      } catch {
        ready = false
      }
      if (this.disposed) return
      if (!ready) {
        store().patch({
          notice: {
            key:
              engine.provider === 'apple'
                ? 'speech.nativeNotReady'
                : isCloudProvider(engine.provider)
                  ? 'voice.cloud.noKey'
                  : 'voice.conv.modelMissing',
          },
        })
        return
      }
      await speechStartCapture(p.dictationMicrophoneId)
      if (this.disposed) {
        // The controller went away while the mic was opening; nobody would ever close it.
        void speechStopCapture().catch(() => undefined)
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
      text = (
        await speechStopAndTranscribe(engine.modelId, engine.locale, {
          provider: engine.provider,
          fallbackLocale: engine.fallbackLocale,
          usage: 'conversation',
        })
      ).trim()
    } catch (cause) {
      await speechStopCapture().catch(() => undefined)
      store().patch({
        capture: nextCapture('transcribing', 'failed'),
        notice: failure(cause, engine.provider),
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

  pinTarget(ptyId: string | null): void {
    store().patch({ pinnedPtyId: ptyId })
  }

  stopSpeaking(): void {
    this.narrator.stop()
  }

  dismiss(): void {
    store().patch({ notice: null, transcript: '', narration: '' })
  }

  private targets(): VoiceTarget[] {
    return listClaudeTargets(
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

  /** Shows the target pane the way the voice command bar does, so its PTY streams again. */
  private showTarget(target: VoiceTarget): void {
    const projects = useProjectsStore.getState()
    projects.setActiveProjectOnly(target.projectId)
    projects.focusWorkspaceTerminal(target.projectId, target.terminalId)
    const ui = useUiStore.getState()
    ui.setActiveTerminal(target.projectId, target.terminalId)
    ui.requestPaneFocus(target.terminalId)
  }

  private currentTarget(): VoiceTarget | null {
    return resolveTarget(this.targets(), {
      pinnedPtyId: store().pinnedPtyId,
      activeTerminalId: useUiStore.getState().activeTerminal?.terminalId ?? null,
      lastClaudePtyId: this.lastClaudePtyId,
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
      if (!p.voiceCommandApiKey) {
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
      store().patch({ notice: { key: 'voice.conv.targetGone' } })
      return
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
      // Claude Code runs no Stop hook after an interrupt, so the turn the Esc cut short ends here.
      if (interrupt && this.isTurnTarget(target.ptyId)) {
        this.stopPolling()
        this.narrator.endTurn()
        await this.closeTurn()
      }
      return
    }
    const midTurn = store().turn !== 'idle' && store().target?.ptyId === target.ptyId
    if (!midTurn) await this.beginTurn(target)
    // Held before the Enter, so a permission request the prompt triggers at once is held too.
    await voiceSetTargets([target.ptyId])
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

  /** Undoes `beginTurn` + targeting for a prompt that was never submitted. */
  private async abandonTurn(): Promise<void> {
    this.generation += 1
    this.pollTarget = null
    this.cursor = null
    const running = store().turn !== 'idle' ? store().target : null
    await voiceSetTargets(running ? [running.ptyId] : []).catch(() => undefined)
  }

  /** Marks where this turn starts in the transcript, so narration never re-reads an older turn. */
  private async beginTurn(target: VoiceTarget): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.pollTarget = null
    this.revision = null
    this.cursor = null
    try {
      const snapshot = await agentTranscriptSnapshot('claude', target.cwd, target.sessionId, null)
      if (generation === this.generation) {
        this.cursor = snapshot.firstIndex + snapshot.messages.length
        this.revision = snapshot.revision
        this.pollTarget = target
      }
    } catch {
      // No transcript: intermediate narration stays off this turn; the final answer still comes
      // from the Stop hook.
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
    await this.narrator.onStop(finalText)
    await this.closeTurn()
  }

  private async closeTurn(): Promise<void> {
    this.generation += 1
    this.pollTarget = null
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
      const snapshot = await agentTranscriptSnapshot(
        'claude',
        fresh.cwd,
        fresh.sessionId,
        this.revision,
      )
      // The turn ended or another began meanwhile: this read belongs to neither.
      if (generation !== this.generation || this.cursor === null) return
      this.revision = snapshot.revision
      if (snapshot.unchanged) return
      const next = newAssistantTexts(snapshot, this.cursor)
      this.cursor = next.cursor
      this.narrator.onAssistantText(next.texts)
    } catch {
      // An unreadable transcript only costs intermediate narration.
    }
  }

  private async speak(text: string): Promise<void> {
    store().patch({ narration: text })
    if (this.ttsUnavailable) return
    const choice = prefs().voiceTts
    const estimate = estimateSpeechMs(text, choice.rate)
    try {
      const id = await ttsSpeak(text, choice)
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const arm = (ms: number) => {
          clearTimeout(timer)
          timer = setTimeout(done, ms)
        }
        const done = () => {
          clearTimeout(timer)
          this.endWaiters.delete(id)
          this.startWaiters.delete(id)
          resolve()
        }
        this.endWaiters.set(id, done)
        // The system voice speaks as soon as it is asked; the others only once synthesized.
        if (choice.provider === 'system' || this.earlyStarts.delete(id)) {
          arm(estimate)
          return
        }
        arm(estimate + TTS_START_GRACE_MS)
        this.startWaiters.set(id, () => {
          this.startWaiters.delete(id)
          arm(estimate)
        })
      })
    } catch {
      this.ttsUnavailable = true
      store().patch({ notice: { key: 'voice.conv.ttsUnavailable' } })
    }
  }

  private onTtsStarted(id: number): void {
    if (this.disposed) return
    const waiter = this.startWaiters.get(id)
    if (waiter) {
      waiter()
      return
    }
    // `tts_speak` has not returned this id yet.
    if (this.earlyStarts.size >= EARLY_STARTS_KEPT) this.earlyStarts.clear()
    this.earlyStarts.add(id)
  }

  private stopSpeech(): void {
    void ttsStop().catch(() => undefined)
    for (const done of [...this.endWaiters.values()]) done()
  }
}
