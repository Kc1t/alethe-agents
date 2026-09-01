import { getLocale, translate } from './i18n'
import type { AgentType } from './types'
import { notifyAgentDone } from './notifications'
import { pathSegments } from './paths'

const RESPONSE_IDLE_MS = 4500
const MIN_RESPONSE_MS = 700
const ECHO_GRACE_MS = 350
const MIN_OUTPUT_CHARS_AFTER_ECHO = 12

type MonitorState = 'idle' | 'armed' | 'working'

export type AgentCompletionMonitorOptions = {
  ptyId: string
  agent: Exclude<AgentType, 'shell'>
  label?: string
  cwd?: string | null
  onStatusChange?: (status: 'working' | 'waiting') => void
  onComplete?: () => void
                                                                                    
  notifyOnComplete?: boolean
}

export class AgentCompletionMonitor {
  private state: MonitorState = 'idle'
  private inputLine = ''
  private submittedPrompt = ''
  private submittedAt = 0
  private outputChars = 0
  private idleTimer: number | null = null
  private disposed = false

  constructor(private readonly options: AgentCompletionMonitorOptions) {}

  handleInput(data: string): void {
    if (this.disposed) return
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const prompt = this.inputLine.trim()
        this.inputLine = ''
        if (prompt.length > 0) this.arm(prompt)
      } else if (ch === '\b' || ch === '\x7f') {
        this.inputLine = this.inputLine.slice(0, -1)
      } else if (ch >= ' ') {
        this.inputLine += ch
      }
    }
  }

  handleOutput(chunk: string): void {
    if (this.disposed || this.state === 'idle') return

    const text = stripTerminalControls(chunk).trim()
    if (!text) return

    if (this.isLikelyImmediateEcho(text)) return

    this.outputChars += text.length
    if (this.state === 'armed' && this.outputChars >= MIN_OUTPUT_CHARS_AFTER_ECHO) {
      this.state = 'working'
      this.options.onStatusChange?.('working')
    }

    if (this.state === 'working') this.scheduleCompletion()
  }

  dispose(): void {
    this.disposed = true
    this.clearIdleTimer()
  }

  private arm(prompt: string): void {
    this.clearIdleTimer()
    this.state = 'armed'
    this.submittedPrompt = prompt
    this.submittedAt = Date.now()
    this.outputChars = 0
    this.options.onStatusChange?.('working')
  }

  private isLikelyImmediateEcho(text: string): boolean {
    if (Date.now() - this.submittedAt > ECHO_GRACE_MS) return false
    return this.submittedPrompt.length > 0 && text.includes(this.submittedPrompt)
  }

  private scheduleCompletion(): void {
    this.clearIdleTimer()
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null
      if (this.disposed || this.state !== 'working') return
      if (Date.now() - this.submittedAt < MIN_RESPONSE_MS) return

      this.state = 'idle'
      this.options.onStatusChange?.('waiting')
      this.options.onComplete?.()
      if (this.options.notifyOnComplete !== false) {
        void notifyAgentDone(
          translate(getLocale(), 'notif.agentDoneTitle', { agent: agentLabel(this.options.agent) }),
          buildNotificationBody(this.options),
          { agent: this.options.agent },
        )
      }
    }, RESPONSE_IDLE_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === null) return
    window.clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

function buildNotificationBody(options: AgentCompletionMonitorOptions): string {
  const locale = getLocale()
  const label = options.label?.trim()
  const cwd = options.cwd?.trim()
  if (label && cwd)
    return translate(locale, 'notif.respondedInPath', { label, path: shortPath(cwd) })
  if (label) return translate(locale, 'notif.responded', { label })
  if (cwd) return translate(locale, 'notif.responseReadyInPath', { path: shortPath(cwd) })
  return translate(locale, 'notif.responseReady')
}

function agentLabel(agent: Exclude<AgentType, 'shell'>): string {
  if (agent === 'claude') return 'Claude'
  if (agent === 'codex') return 'Codex'
  return 'OpenCode'
}

function shortPath(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = pathSegments(cleaned)
  if (parts.length <= 2) return cleaned
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_].*?\x1b\\/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}
