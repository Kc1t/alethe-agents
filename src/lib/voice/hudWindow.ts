/** Label of the floating voice HUD window (see `voice_hud.rs`). */
export const VOICE_HUD_LABEL = 'voice-hud'

/** True when the current window is the voice HUD; `null` means the label is unknown. */
export function isVoiceHudWindow(label: string | null): boolean {
  return label === VOICE_HUD_LABEL
}
