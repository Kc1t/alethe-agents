import { create } from 'zustand'

import type { MessageKey } from '../lib/i18n/messages/en'
import type { VoiceCapture, VoiceTurn } from '../lib/voice/stateMachine'
import type { VoiceTarget } from '../lib/voice/target'

export type VoiceNotice = { key: MessageKey; params?: Record<string, string | number> }

export type VoicePermissionCard = {
  requestId: string
  tool: string
  subject: string
  destructive: boolean
}

type VoiceConversationData = {
  capture: VoiceCapture
  turn: VoiceTurn
  target: VoiceTarget | null
  /** A pane the person picked on the panel; wins over the active pane until it closes. */
  pinnedPtyId: string | null
  /** Last thing heard; kept when it could not be sent, so it is not lost. */
  transcript: string
  /** Last thing narrated, shown as text too (and only as text when TTS is unavailable). */
  narration: string
  permission: VoicePermissionCard | null
  notice: VoiceNotice | null
  /** PTYs launched with the voice hooks (`agentVoiceHookedPtys`); only these can be targets. */
  voiceHookedPtyIds: string[]
  /** The HUD was closed with its button; it stays hidden until the next press. */
  hudDismissed: boolean
  /** When the conversation last went idle; the HUD lingers for a moment after it. */
  idleSince: number | null
  /** The preference recorder is capturing a new shortcut; voice shortcuts are paused. */
  shortcutRecording: boolean
}

type VoiceConversationState = VoiceConversationData & {
  patch: (next: Partial<VoiceConversationData>) => void
}

export const INITIAL_VOICE_CONVERSATION: VoiceConversationData = {
  capture: 'idle',
  turn: 'idle',
  target: null,
  pinnedPtyId: null,
  transcript: '',
  narration: '',
  permission: null,
  notice: null,
  voiceHookedPtyIds: [],
  hudDismissed: false,
  idleSince: null,
  shortcutRecording: false,
}

export const useVoiceConversationStore = create<VoiceConversationState>((set) => ({
  ...INITIAL_VOICE_CONVERSATION,
  patch: (next) => set(next),
}))

/** App key handlers stand down while the preference recorder is capturing a new shortcut. */
export const isRecordingShortcut = () => useVoiceConversationStore.getState().shortcutRecording
