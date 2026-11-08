import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export const voiceHudSnapshot = (): Promise<string | null> => invoke('voice_hud_snapshot')
export const voiceHudAction = (action: string): Promise<void> =>
  invoke('voice_hud_action', { action })
export const voiceHudMoved = (): Promise<void> => invoke('voice_hud_moved')

export const onVoiceHudState = (handler: (state: string) => void): Promise<UnlistenFn> =>
  listen<string>('voice-hud://state', (e) => handler(e.payload))
