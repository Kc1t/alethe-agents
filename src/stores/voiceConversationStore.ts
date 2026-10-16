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
  /** A session the person picked on the panel; wins over the active pane until it closes. */
  pinnedPtyId: string | null
  /** Last thing heard; kept when it could not be sent, so it is not lost. */
  transcript: string
  /** Last thing narrated, shown as text too (and only as text when TTS is unavailable). */
  narration: string
  /**
   * How far into `narration` speech has got, in code points: the word there is highlighted and
   * the text before it shows as spoken. Null shows plain text (nothing spoken through TTS).
   */
  narrationSpokenOffset: number | null
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
  /** Narration plays on in silence; for this session only (Rust keeps the same flag). */
  muted: boolean
  /** Narration is held; new items queue until it resumes. A press or stop clears it. */
  narrationPaused: boolean
  /** Narration is speaking or queued (paused included); Pause is offered only then. */
  narrationActive: boolean
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
  narrationSpokenOffset: null,
  permission: null,
  notice: null,
  voiceHookedPtyIds: [],
  hudDismissed: false,
  idleSince: null,
  shortcutRecording: false,
  muted: false,
  narrationPaused: false,
  narrationActive: false,
}

export const useVoiceConversationStore = create<VoiceConversationState>((set) => ({
  ...INITIAL_VOICE_CONVERSATION,
  patch: (next) => set(next),
}))

/** App key handlers stand down while the preference recorder is capturing a new shortcut. */
export const isRecordingShortcut = () => useVoiceConversationStore.getState().shortcutRecording
