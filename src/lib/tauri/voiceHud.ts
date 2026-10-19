import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { HudPreset, VoiceHudCustomPosition, VoiceHudPosition } from '../types'

export type { HudPreset, VoiceHudCustomPosition, VoiceHudPosition }

export type HudPlacement =
  { kind: 'preset'; preset: HudPreset } | { kind: 'custom'; custom: VoiceHudCustomPosition }

export function hudPlacement(
  position: VoiceHudPosition,
  custom: VoiceHudCustomPosition | null,
): HudPlacement {
  if (position === 'custom' && custom) return { kind: 'custom', custom }
  return { kind: 'preset', preset: position === 'custom' ? 'bottom-center' : position }
}

export const voiceHudShow = (placement: HudPlacement): Promise<void> =>
  invoke('voice_hud_show', { placement })
export const voiceHudHide = (): Promise<void> => invoke('voice_hud_hide')
export const voiceHudPublish = (state: string): Promise<void> =>
  invoke('voice_hud_publish', { state })
export const voiceHudSnapshot = (): Promise<string | null> => invoke('voice_hud_snapshot')
export const voiceHudAction = (action: string): Promise<void> =>
  invoke('voice_hud_action', { action })
export const voiceHudMoved = (): Promise<void> => invoke('voice_hud_moved')
export const voiceShortcutSet = (accelerator: string | null): Promise<void> =>
  invoke('voice_shortcut_set', { accelerator })

export const onVoiceShortcut = (
  handler: (e: { state: 'pressed' | 'released'; jev: boolean }) => void,
): Promise<UnlistenFn> =>
  listen<{ state: 'pressed' | 'released'; jev: boolean }>('voice://shortcut', (e) =>
    handler(e.payload),
  )
export const onVoiceHudState = (handler: (state: string) => void): Promise<UnlistenFn> =>
  listen<string>('voice-hud://state', (e) => handler(e.payload))
export const onVoiceHudAction = (handler: (action: string) => void): Promise<UnlistenFn> =>
  listen<string>('voice-hud://action', (e) => handler(e.payload))
export const onVoiceHudMoved = (
  handler: (pos: VoiceHudCustomPosition) => void,
): Promise<UnlistenFn> =>
  listen<VoiceHudCustomPosition>('voice-hud://moved', (e) => handler(e.payload))
