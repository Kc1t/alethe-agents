import type {
  VoiceConversationAction,
  VoiceConversationViewState,
} from '../../components/VoiceConversation/VoiceConversationView'
import type { Locale, Theme, VisualStyle, VoiceApprovalChannel } from '../types'
import type { VoiceTarget } from './target'

export const SPEECH_RATES = [1, 1.25, 1.5, 2] as const

export type HudViewState = {
  state: VoiceConversationViewState
  targets: VoiceTarget[]
  hint: string
  approvalChannel: VoiceApprovalChannel
  destructiveNeedsHud: boolean
  rate: number
  /** The HUD renders with these instead of re-reading the profile on every save. */
  language: Locale
  uiTheme: Theme
  visualStyle: VisualStyle
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
  return value as unknown as HudViewState
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
    case 'stop-speaking':
      return { kind: 'stop-speaking' }
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
