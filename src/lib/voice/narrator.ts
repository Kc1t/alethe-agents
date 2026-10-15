import type { MessageKey } from '../i18n/messages/en'
import type { TranscriptEvent } from '../tauri/handoff'
import type { VoiceVerbosity } from '../types'

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string
export type ToolCall = { tool_name?: string; tool_input?: Record<string, unknown> }

const MAX_LIST_ITEMS = 3
const FILL_CHECK_MS = 1000

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

/** Turns Claude's markdown into something worth hearing: no syntax, no code, no tables. */
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
    default:
      return t('voice.narration.working', { tool: tool.tool_name ?? '?' })
  }
}

/** Assistant text at or past `cursor` (an absolute event index), and where the next read starts. */
export function newAssistantTexts(
  snapshot: { firstIndex: number; messages: TranscriptEvent[] },
  cursor: number,
): { texts: string[]; cursor: number } {
  const end = snapshot.firstIndex + snapshot.messages.length
  const texts = snapshot.messages
    .filter(
      (message, offset) => snapshot.firstIndex + offset >= cursor && message.role === 'assistant',
    )
    .map((message) => message.text)
  return { texts, cursor: Math.max(cursor, end) }
}

/** How long an engine without end callbacks gets before the queue moves on. */
export function estimateSpeechMs(text: string, rate: number): number {
  return Math.min(60_000, (1_500 + text.length * 75) / Math.max(0.5, rate))
}

export type NarratorDeps = {
  /** Resolves when the utterance ended or was stopped. */
  speak: (text: string) => Promise<void>
  stop: () => void
  t: Translate
  verbosity: () => VoiceVerbosity
  fillAfterMs: () => number
  now?: () => number
}

export class Narrator {
  private queue: string[] = []
  private speaking = false
  private generation = 0
  private tool: ToolCall | null = null
  private lastActivityAt = 0
  private lastQueued = ''
  private fillTimer: ReturnType<typeof setInterval> | null = null
  private idleWaiters: Array<() => void> = []

  constructor(private readonly deps: NarratorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  beginTurn(): void {
    this.tool = null
    this.lastQueued = ''
    this.lastActivityAt = this.now()
    this.clearFill()
    this.fillTimer = setInterval(() => this.maybeFill(), FILL_CHECK_MS)
  }

  onAssistantText(texts: string[]): void {
    const level = this.deps.verbosity()
    if (level !== 'normal' && level !== 'detailed') return
    for (const text of texts) this.enqueue(speakableText(text, this.deps.t))
  }

  onToolStart(tool: ToolCall): void {
    this.tool = tool
    if (this.deps.verbosity() === 'detailed') this.enqueue(statusFill(tool, this.deps.t))
  }

  onToolEnd(): void {
    this.tool = null
  }

  /** Permission questions are heard whatever the verbosity, ahead of anything queued. */
  announce(text: string): void {
    this.enqueue(text, true)
  }

  onStop(finalText: string): Promise<void> {
    this.tool = null
    this.clearFill()
    if (this.deps.verbosity() !== 'silent') {
      const spoken = speakableText(finalText, this.deps.t)
      if (spoken && spoken !== this.lastQueued) this.enqueue(spoken)
    }
    return this.whenIdle()
  }

  /** Barge-in: the person started talking. No status fill follows for the tool that was running. */
  stop(): void {
    this.generation += 1
    this.queue = []
    this.tool = null
    this.lastActivityAt = this.now()
    this.deps.stop()
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

  private enqueue(text: string, front = false): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (front) this.queue.unshift(trimmed)
    else this.queue.push(trimmed)
    if (!front) this.lastQueued = trimmed
    this.lastActivityAt = this.now()
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.speaking) return
    this.speaking = true
    const generation = this.generation
    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const next = this.queue.shift()!
        await this.deps.speak(next).catch(() => undefined)
        this.lastActivityAt = this.now()
      }
    } finally {
      this.speaking = false
      if (this.queue.length > 0) void this.drain()
      else this.resolveIdle()
    }
  }

  private whenIdle(): Promise<void> {
    if (!this.speaking && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private resolveIdle(): void {
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private maybeFill(): void {
    const level = this.deps.verbosity()
    if (!this.tool || this.speaking || this.queue.length > 0) return
    if (level !== 'normal' && level !== 'detailed') return
    if (this.now() - this.lastActivityAt < this.deps.fillAfterMs()) return
    this.enqueue(statusFill(this.tool, this.deps.t))
  }

  private clearFill(): void {
    if (this.fillTimer !== null) clearInterval(this.fillTimer)
    this.fillTimer = null
  }
}
