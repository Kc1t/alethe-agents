import { invoke } from '@tauri-apps/api/core'

import type { HandoffScope } from '../types'

export type HandoffProvider = 'claude' | 'codex'

export type HandoffDraft = {
  sourceProvider: HandoffProvider
  targetProvider: HandoffProvider
  sourceSessionId: string
  cwd: string
  title: string
  content: string
  includedEventCount: number
  omittedEventCount: number
  redactionCount: number
  usedFallback: boolean
}

export type HandoffArtifact = {
  handoffId: string
  contextDir: string
  contextPath: string
}

export function prepareAgentHandoff(args: {
  sourceProvider: HandoffProvider
  targetProvider: HandoffProvider
  sourceSessionId?: string
  cwd: string
  scope: HandoffScope
}): Promise<HandoffDraft> {
  return invoke<HandoffDraft>('prepare_agent_handoff', args)
}

export function materializeAgentHandoff(content: string): Promise<HandoffArtifact> {
  return invoke<HandoffArtifact>('materialize_agent_handoff', { content })
}

export function completeAgentHandoff(handoffId: string): Promise<void> {
  return invoke('complete_agent_handoff', { handoffId })
}

export type TranscriptEvent = {
  role: 'user' | 'assistant' | 'tool' | 'tool-result' | 'question'
  text: string
}

export type TranscriptSnapshot = {
  sessionId: string | null
  revision: number
  unchanged: boolean
  /** Absolute index of `messages[0]` among every event of the transcript. */
  firstIndex: number
  messages: TranscriptEvent[]
}

export function agentTranscriptSnapshot(
  provider: 'claude' | 'codex',
  cwd: string,
  sessionId: string | null,
  since: number | null,
): Promise<TranscriptSnapshot> {
  return invoke<TranscriptSnapshot>('agent_transcript_snapshot', {
    provider,
    cwd,
    sessionId,
    since,
  })
}
