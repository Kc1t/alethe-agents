import type { VoiceConversationAction } from '../../components/VoiceConversation/VoiceConversationView'
import type { MessageKey } from '../i18n/messages/en'
import type { AgentType, Locale, Theme, VisualStyle } from '../types'
import type { VoiceCapture, VoiceTurn } from './stateMachine'

export const SPEECH_RATES = [1, 1.25, 1.5, 2] as const

export type VoiceApprovalChannel = 'both' | 'voice' | 'hud'

export type VoiceTarget = {
  ptyId: string
  projectId: string
  terminalId: string
  tabId: string
  tabActive: boolean
  agent?: AgentType
  label: string
  cwd: string
  sessionId: string | null
}

// The HUD runs no plugins, so a plugin's own message keys only resolve in its window: send `text`.
export type VoiceNotice =
  { key: MessageKey; params?: Record<string, string | number> } | { text: string }

export type VoicePermissionCard = {
  requestId: string
  tool: string
  subject: string
  destructive: boolean
}

export type VoiceConversationViewState = {
  capture: VoiceCapture
  turn: VoiceTurn
  target: VoiceTarget | null
  pinnedPtyId: string | null
  transcript: string
  narration: string
  // Code points into `narration` reached by speech; null shows plain text.
  narrationSpokenOffset: number | null
  permission: VoicePermissionCard | null
  notice: VoiceNotice | null
  muted: boolean
  narrationPaused: boolean
  narrationActive: boolean
}

export const IDLE_VOICE_CONVERSATION: VoiceConversationViewState = {
  capture: 'idle',
  turn: 'idle',
  target: null,
  pinnedPtyId: null,
  transcript: '',
  narration: '',
  narrationSpokenOffset: null,
  permission: null,
  notice: null,
  muted: false,
  narrationPaused: false,
  narrationActive: false,
}

export type HudViewState = {
  state: VoiceConversationViewState
  targets: VoiceTarget[]
  current?: VoiceTarget | null
  restartable?: VoiceTarget[]
  hint: string
  approvalChannel: VoiceApprovalChannel
  destructiveNeedsHud: boolean
  rate: number
  language: Locale
  uiTheme: Theme
  visualStyle: VisualStyle
  reducedMotion?: boolean
}

export function encodeHudState(state: HudViewState): string {
  return JSON.stringify(state)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export function decodeHudState(json: string | null): HudViewState | null {
  if (!json) return null
  const value = parse(json)
  if (!isRecord(value) || !isRecord(value.state) || typeof value.rate !== 'number') return null
  if (!Array.isArray(value.targets)) return null
  if (typeof value.language !== 'string' || typeof value.uiTheme !== 'string') return null
  if (typeof value.visualStyle !== 'string') return null
  // Older publishers omit the narration controls and the spoken offset.
  const offset = value.state.narrationSpokenOffset
  const state = {
    ...value.state,
    muted: value.state.muted === true,
    narrationPaused: value.state.narrationPaused === true,
    narrationActive: value.state.narrationActive === true,
    narrationSpokenOffset: typeof offset === 'number' && Number.isFinite(offset) ? offset : null,
  }
  const { restartable, ...rest } = value
  return {
    ...rest,
    ...(Array.isArray(restartable) ? { restartable } : {}),
    state,
  } as unknown as HudViewState
}

export function decodeHudAction(json: string): VoiceConversationAction | null {
  const value = parse(json)
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'answer': {
      const { answer, requestId } = value
      if (typeof requestId !== 'string' || !requestId || !isRecord(answer)) return null
      if (answer.kind === 'allow' || answer.kind === 'defer') {
        return { kind: 'answer', requestId, answer: { kind: answer.kind } }
      }
      if (answer.kind !== 'deny') return null
      if (answer.message === undefined)
        return { kind: 'answer', requestId, answer: { kind: 'deny' } }
      if (typeof answer.message !== 'string') return null
      return {
        kind: 'answer',
        requestId,
        answer: { kind: 'deny', ...(answer.message ? { message: answer.message } : {}) },
      }
    }
    case 'pin':
      return value.ptyId === null || typeof value.ptyId === 'string'
        ? { kind: 'pin', ptyId: value.ptyId }
        : null
    case 'restart-session':
      return typeof value.ptyId === 'string' && value.ptyId
        ? { kind: 'restart-session', ptyId: value.ptyId }
        : null
    case 'stop-speaking':
      return { kind: 'stop-speaking' }
    case 'toggle-mute':
      return { kind: 'toggle-mute' }
    case 'toggle-pause':
      return { kind: 'toggle-pause' }
    case 'dismiss':
      return { kind: 'dismiss' }
    case 'rate':
      return typeof value.rate === 'number' && value.rate >= 0.5 && value.rate <= 2
        ? { kind: 'rate', rate: value.rate }
        : null
    default:
      return null
  }
}
