export const HUD_IDLE_HIDE_MS = 4000
export type VoiceSurface = 'dock' | 'hud' | 'none'

/** The panel inside Alethe when it is focused, the HUD while it is not. */
export function voiceSurface(input: {
  mainFocused: boolean
  active: boolean
  idleSince: number | null
  now: number
  dismissed: boolean
}): VoiceSurface {
  if (input.mainFocused) return 'dock'
  if (input.dismissed) return 'none'
  if (input.active) return 'hud'
  if (input.idleSince !== null && input.now - input.idleSince < HUD_IDLE_HIDE_MS) return 'hud'
  return 'none'
}
