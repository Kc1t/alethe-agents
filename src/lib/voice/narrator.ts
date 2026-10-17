import type { MessageKey } from '../i18n/messages/en'
import type { TranscriptEvent, TranscriptToolSummary } from '../tauri/handoff'
import type { VoiceNarration } from '../types'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string
export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> }

const MAX_LIST_ITEMS = 3
const FILL_CHECK_MS = 1000

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** Turns an agent's markdown into something worth hearing: no syntax, no code, no tables. */
export function speakableText(markdown: string, t: Translate): string {
  const lines = markdown
    .replace(/```[\s\S]*?(?:```|$)/g, `\n${t('voice.narration.codeBlock')}\n`)
    .split('\n')
  const out: string[] = []
  let listItems = 0
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\|.*\|$/.test(line)) {
      if (!inTable) out.push(t('voice.narration.table'))
      inTable = true
      continue
    }
    inTable = false
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (item) {
      listItems += 1
      if (listItems <= MAX_LIST_ITEMS) out.push(item[1])
      continue
    }
    if (listItems > MAX_LIST_ITEMS) {
      out.push(t('voice.narration.moreItems', { count: listItems - MAX_LIST_ITEMS }))
    }
    listItems = 0
    if (line) out.push(line)
  }
  if (listItems > MAX_LIST_ITEMS) {
    out.push(t('voice.narration.moreItems', { count: listItems - MAX_LIST_ITEMS }))
  }
  return out
    .join(' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, t('voice.narration.link'))
    .replace(/^#{1,6}\s+/g, '')
    .replace(/\s#{1,6}\s+/g, ' ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function statusFill(tool: ToolCall, t: Translate): string {
  const input = tool.tool_input ?? {}
  switch (tool.tool_name) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command) ?? ''
      if (/\b(test|tests|vitest|jest|pytest|cargo test)\b/.test(command)) {
        return t('voice.narration.runningTests')
      }
      const what = str(input.description)
      return what
        ? t('voice.narration.runningCommand', { what })
        : t('voice.narration.runningShell')
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return t('voice.narration.editing', {
        file: basename(str(input.file_path) ?? str(input.notebook_path) ?? ''),
      })
    case 'Read':
      return t('voice.narration.reading', { file: basename(str(input.file_path) ?? '') })
    case 'Grep':
    case 'Glob':
      return t('voice.narration.searching')
    case 'WebFetch':
    case 'WebSearch':
      return t('voice.narration.browsing')
    case 'Task':
    case 'Agent':
      return t('voice.narration.delegating')
    case 'AskUserQuestion':
      return t('voice.narration.asking')
    default:
      return t('voice.narration.working', { tool: tool.tool_name ?? '?' })
  }
}

/** Codex's tool names, as the Claude tools `statusFill` knows. */
const CODEX_TOOLS: Record<string, string> = {
  shell: 'Bash',
  shell_command: 'Bash',
  local_shell: 'Bash',
  exec_command: 'Bash',
  apply_patch: 'Edit',
  view_image: 'Read',
  web_search: 'WebSearch',
  request_user_input: 'AskUserQuestion',
}

/** A tool call read from a transcript (Codex has no hooks), in the shape a hook gives. */
export function transcriptToolCall(tool: TranscriptToolSummary): ToolCall {
  return {
    tool_name: CODEX_TOOLS[tool.name] ?? tool.name,
    tool_input: { command: tool.command, file_path: tool.path, description: tool.description },
  }
}

/** Events at or past `cursor` (an absolute event index), and where the next read starts. */
export function newTranscriptEvents(
  snapshot: { firstIndex: number; messages: TranscriptEvent[] },
  cursor: number,
): { events: TranscriptEvent[]; cursor: number } {
  const end = snapshot.firstIndex + snapshot.messages.length
  const events = snapshot.messages.filter((_, offset) => snapshot.firstIndex + offset >= cursor)
  return { events, cursor: Math.max(cursor, end) }
}

/** Assistant text at or past `cursor` (an absolute event index), and where the next read starts. */
export function newAssistantTexts(
  snapshot: { firstIndex: number; messages: TranscriptEvent[] },
  cursor: number,
): { texts: string[]; cursor: number } {
  const next = newTranscriptEvents(snapshot, cursor)
  const texts = next.events
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
  return { texts, cursor: next.cursor }
}

/** Ends of sentences: `.`, `!`, `?` or `…` before a space (so `auth.ts` stays whole), CJK marks. */
const SENTENCE_END = /[.!?…]+(?=\s|$)|[。！？]+/g

/**
 * Where to pick up an utterance that was cut short: `fraction` (the share of its estimated time
 * already spoken) is mapped to a character offset, rounded down to the start of the sentence it
 * falls in, and the text from there is returned. Never empty: past the end it is the last
 * sentence.
 */
export function resumeFrom(text: string, fraction: number): string {
  const reached = Math.max(0, Math.min(1, fraction)) * text.length
  let from = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length
    if (end > reached) break
    if (text.slice(end).trim()) from = end
  }
  return text.slice(from).trim() || text.trim()
}

/** The pace speech is estimated at, at rate 1. */
export const SPEECH_MS_PER_CHAR = 75

/** How long an engine without end callbacks gets before the queue moves on. */
export function estimateSpeechMs(text: string, rate: number): number {
  return Math.min(60_000, (1_500 + text.length * SPEECH_MS_PER_CHAR) / Math.max(0.5, rate))
}

export type NarratorDeps = {
  /** Resolves when the utterance ended or was stopped; `shown` is the whole item it belongs to. */
  speak: (text: string, shown: string) => Promise<void>
  stop: () => void
  /** Ends the wait for the utterance in flight without stopping it; the next speak replaces it. */
  skip?: () => void
  /** Prepares the item queued next while the current one plays (cloud voices). */
  prefetch?: (text: string) => void
  /** Holds the utterance in flight where it is (cloud and local voices). */
  pauseSpeech?: () => void
  resumeSpeech?: () => void
  /**
   * The engine cannot hold an utterance (the system voice): a pause stops it, and a resume speaks
   * it again from the start of the sentence it had reached (`progress`, see `resumeFrom`).
   */
  restartsOnPause?: () => boolean
  /** Share (0–1) of the utterance in flight already spoken, by its estimated duration. */
  progress?: () => number
  onPausedChange?: (paused: boolean) => void
  /** Something is speaking or queued (a paused item counts); only then can it be paused. */
  onActiveChange?: (active: boolean) => void
  t: Translate
  /** What to speak, per category (`Preferences.voiceNarration`). */
  narration: () => VoiceNarration
  fillAfterMs: () => number
  now?: () => number
}

/** The item being spoken, and what is left of it after an interruption. */
type Current = { text: string; remaining: string; restarts: boolean }

export class Narrator {
  private queue: string[] = []
  private speaking = false
  private current: Current | null = null
  private paused = false
  /** The utterance in flight was held through `pauseSpeech`; resume releases it. */
  private held = false
  /** The utterance in flight was cut short (pause, restart): what is left is said again. */
  private interrupted = false
  private active = false
  private generation = 0
  private tool: ToolCall | null = null
  private lastActivityAt = 0
  private lastQueued = ''
  /**
   * Text between steps held back while `final` is off: the last text of a turn is its answer, so
   * a text is spoken only once something follows it, and dropped when the turn stops on it.
   */
  private pendingProgress: string | null = null
  private fillTimer: ReturnType<typeof setInterval> | null = null
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: NarratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  beginTurn(): void {
    this.tool = null
    this.lastQueued = ''
    this.pendingProgress = null
    this.lastActivityAt = this.now()
    this.clearFill()
    this.fillTimer = setInterval(() => this.maybeFill(), FILL_CHECK_MS)
  }

  onAssistantText(texts: string[]): void {
    this.onTranscript(
      texts.map((text) => ({ role: 'assistant', text })),
      { tools: false },
    )
  }

  /**
   * New transcript events, in order. `tools`: its tool calls are the only ones this turn gets
   * (Codex); Claude's come from its hooks, so its transcript's tool calls are not said twice.
   */
  onTranscript(events: TranscriptEvent[], options: { tools: boolean }): void {
    for (const event of events) {
      if (event.role === 'user') continue
      // Anything after a held text means the turn went on: that text was between steps.
      this.confirmProgress()
      // Whatever follows a transcript tool call ends it: a call with no output has no result.
      if (options.tools) this.onToolEnd()
      const on = this.deps.narration()
      switch (event.role) {
        case 'assistant':
          if (!on.progress) break
          if (on.final) this.enqueue(speakableText(event.text, this.deps.t))
          else this.pendingProgress = speakableText(event.text, this.deps.t)
          break
        case 'thinking':
          if (on.thinking) this.enqueue(speakableText(event.text, this.deps.t))
          break
        case 'question':
          if (on.questions) this.enqueue(speakableText(event.text, this.deps.t))
          break
        case 'tool':
          if (options.tools && event.tool) this.onToolStart(transcriptToolCall(event.tool))
          break
      }
    }
  }

  onToolStart(tool: ToolCall): void {
    this.confirmProgress()
    this.tool = tool
    if (this.deps.narration().tools) this.enqueue(statusFill(tool, this.deps.t))
  }

  onToolEnd(): void {
    this.tool = null
  }

  /** Permission questions are heard ahead of anything queued. */
  announce(text: string): void {
    if (this.deps.narration().permissions) this.enqueue(text, true)
  }

  /**
   * Text the person asked to hear (a terminal selection): read now, in place of anything queued,
   * whatever narration is set to speak.
   */
  read(parts: string[]): void {
    this.stop()
    for (const part of parts) this.enqueue(part)
  }

  /**
   * The turn ended on `finalText`: its answer, or (`permissions`) a line saying the agent is
   * asking in its terminal.
   */
  onStop(finalText: string, category: 'final' | 'permissions' = 'final'): Promise<void> {
    this.tool = null
    this.clearFill()
    // Nothing followed it: the text held back was the answer.
    this.pendingProgress = null
    if (this.deps.narration()[category]) {
      const spoken = speakableText(finalText, this.deps.t)
      if (spoken && spoken !== this.lastQueued) this.enqueue(spoken)
    }
    return this.whenIdle()
  }

  /** Barge-in: the person started talking. No status fill follows for the tool that was running. */
  stop(): void {
    this.generation += 1
    this.queue = []
    this.current = null
    this.tool = null
    this.pendingProgress = null
    this.lastActivityAt = this.now()
    this.held = false
    this.setPaused(false)
    this.deps.stop()
    // Paused, nothing is draining to report the queue empty.
    if (!this.speaking) this.resolveIdle()
    this.syncActive()
  }

  /** Holds narration; what arrives meanwhile queues. The turn does not end while paused. */
  pause(): void {
    // Nothing to hold: a pause would stay on with nothing to resume.
    if (this.paused || !this.hasNarration()) return
    this.setPaused(true)
    const current = this.current
    if (!this.speaking || !current) return
    if (current.restarts) {
      this.cutShort(current)
      this.deps.stop()
    } else {
      this.held = true
      this.deps.pauseSpeech?.()
    }
  }

  isPaused(): boolean {
    return this.paused
  }

  resume(): void {
    if (!this.paused) return
    this.setPaused(false)
    if (this.held) {
      this.held = false
      this.deps.resumeSpeech?.()
    }
    void this.drain()
  }

  /**
   * Speaks the item in flight again from the sentence it had reached, so a new volume is heard
   * at once on an engine that takes it per utterance. A held (player) utterance needs nothing.
   */
  restartSentence(): void {
    const skip = this.deps.skip
    if (!skip || this.paused || !this.speaking || !this.current?.restarts) return
    this.cutShort(this.current)
    skip()
  }

  /** Keeps what is left of `current` from the sentence reached; called before it is stopped. */
  private cutShort(current: Current): void {
    current.remaining = resumeFrom(current.remaining, this.deps.progress?.() ?? 0)
    this.interrupted = true
  }

  /** The turn ended with no Stop to narrate (an interrupt, a closed pane). */
  endTurn(): void {
    this.stop()
    this.clearFill()
  }

  dispose(): void {
    this.endTurn()
    this.resolveIdle()
  }

  private confirmProgress(): void {
    const text = this.pendingProgress
    this.pendingProgress = null
    if (text) this.enqueue(text)
  }

  private enqueue(text: string, front = false): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (front) this.queue.unshift(trimmed)
    else this.queue.push(trimmed)
    if (!front) this.lastQueued = trimmed
    // Next in line behind what is speaking: get it ready now.
    if (this.speaking && this.queue[0] === trimmed) this.deps.prefetch?.(trimmed)
    this.lastActivityAt = this.now()
    this.syncActive()
    void this.drain()
  }

  private hasNarration(): boolean {
    return this.speaking || this.current !== null || this.queue.length > 0
  }

  /**
   * Reports a change in `hasNarration`; a pause left with nothing to resume (the held utterance
   * ended, nothing queued) is let go, so it never outlives the narration it held.
   */
  private syncActive(): void {
    const active = this.hasNarration()
    if (!active && this.paused) {
      this.setPaused(false)
      if (this.held) {
        this.held = false
        this.deps.resumeSpeech?.()
      }
    }
    if (active === this.active) return
    this.active = active
    this.deps.onActiveChange?.(active)
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    this.deps.onPausedChange?.(paused)
  }

  private async drain(): Promise<void> {
    if (this.speaking || this.paused) return
    this.speaking = true
    const generation = this.generation
    try {
      while (generation === this.generation && !this.paused) {
        if (!this.current) {
          const next = this.queue.shift()
          if (next === undefined) break
          const restarts = this.deps.restartsOnPause?.() ?? false
          this.current = { text: next, remaining: next, restarts }
        }
        const current = this.current
        this.interrupted = false
        const next = this.queue[0]
        if (next !== undefined) this.deps.prefetch?.(next)
        await this.deps.speak(current.remaining, current.text).catch(() => undefined)
        this.lastActivityAt = this.now()
        if (generation !== this.generation || this.interrupted) continue
        this.current = null
      }
    } finally {
      this.speaking = false
      this.syncActive()
      if (!this.paused && (this.current || this.queue.length > 0)) void this.drain()
      else if (!this.paused) this.resolveIdle()
    }
  }

  private whenIdle(): Promise<void> {
    if (!this.speaking && !this.paused && !this.current && this.queue.length === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private maybeFill(): void {
    if (!this.tool || this.speaking || this.paused || this.current || this.queue.length > 0) return
    if (!this.deps.narration().status) return
    if (this.now() - this.lastActivityAt < this.deps.fillAfterMs()) return
    this.enqueue(statusFill(this.tool, this.deps.t))
  }

  private clearFill(): void {
    if (this.fillTimer !== null) clearInterval(this.fillTimer)
    this.fillTimer = null
  }
}
