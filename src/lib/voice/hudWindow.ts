// Must match `HUD_LABEL` in voice_hud.rs.
export const VOICE_HUD_LABEL = 'voice-hud'

export function isVoiceHudWindow(label: string | null): boolean {
  return label === VOICE_HUD_LABEL
}
