/**
 * Voice conversation is two machines side by side: capturing what the person says, and Claude's
 * turn. They overlap on purpose: the person may talk while Claude works.
 */
export type VoiceCapture = 'idle' | 'listening' | 'transcribing' | 'sending'
export type VoiceTurn = 'idle' | 'working' | 'awaiting-permission'
export type VoicePhase = VoiceCapture | VoiceTurn

export type CaptureEvent = 'press' | 'captured' | 'transcribed' | 'nothing' | 'done' | 'failed'
export type TurnEvent = 'sent' | 'permission' | 'answered' | 'stopped' | 'reset'

const CAPTURE: Record<VoiceCapture, Partial<Record<CaptureEvent, VoiceCapture>>> = {
  idle: { press: 'listening' },
  listening: { captured: 'transcribing', failed: 'idle' },
  transcribing: { transcribed: 'sending', nothing: 'idle', failed: 'idle' },
  sending: { done: 'idle', failed: 'idle' },
}

const TURN: Record<VoiceTurn, Partial<Record<TurnEvent, VoiceTurn>>> = {
  idle: { sent: 'working' },
  working: { sent: 'working', permission: 'awaiting-permission', stopped: 'idle', reset: 'idle' },
  'awaiting-permission': {
    sent: 'awaiting-permission',
    answered: 'working',
    stopped: 'idle',
    reset: 'idle',
  },
}

export function nextCapture(state: VoiceCapture, event: CaptureEvent): VoiceCapture {
  return CAPTURE[state][event] ?? state
}

export function nextTurn(state: VoiceTurn, event: TurnEvent): VoiceTurn {
  return TURN[state][event] ?? state
}

/** Capture takes precedence over the turn, so talking mid-task reads as listening. */
export function displayPhase(capture: VoiceCapture, turn: VoiceTurn): VoicePhase {
  return capture !== 'idle' ? capture : turn
}
