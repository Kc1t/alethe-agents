export type VoiceCapture = 'idle' | 'listening' | 'transcribing' | 'sending'
export type VoiceTurn = 'idle' | 'working' | 'awaiting-permission'
export type VoicePhase = VoiceCapture | VoiceTurn

// Capture takes precedence over the turn, so talking mid-task reads as listening.
export function displayPhase(capture: VoiceCapture, turn: VoiceTurn): VoicePhase {
  return capture !== 'idle' ? capture : turn
}
