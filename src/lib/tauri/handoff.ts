import { invoke } from '@tauri-apps/api/core'

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
}): Promise<HandoffDraft> {
  return invoke<HandoffDraft>('prepare_agent_handoff', args)
}

export function materializeAgentHandoff(content: string): Promise<HandoffArtifact> {
  return invoke<HandoffArtifact>('materialize_agent_handoff', { content })
}

export function completeAgentHandoff(handoffId: string): Promise<void> {
  return invoke('complete_agent_handoff', { handoffId })
}
