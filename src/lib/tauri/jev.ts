import { invoke } from '@tauri-apps/api/core'

export type JevAnswer = {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type JevAction =
  | 'new_project'
  | 'new_terminal'
  | 'reuse_terminal'
  | 'send_prompt'
  | 'focus_terminal'
  | 'kill_terminal'
  | 'nothing'
  | 'none'

export type JevTask = {
  prompt: string
  promptConfidence: number
  agent: JevAnswer
  count: number
}

export type JevDecision = {
  action: JevAnswer
  agent: JevAnswer
  project: JevAnswer
  terminal: JevAnswer
  prompt: string
  promptConfidence: number
  tasks: JevTask[]
  leadCount: number
  multiTask: number
  parallel: number
  howMany: number
  addressedToApp: number
  destructive: number
  latencyMs: number
  costUsd: number
}

export type JevTerminalRef = {
  id: string
  project: string
  agent: string
  cwd: string
  busy: boolean
  name: string
  ordinal: number
}

export type JevProjectRef = {
  id: string
  name: string
  path: string
}

export type JevContext = {
  projects: JevProjectRef[]
  terminals: JevTerminalRef[]
  agents: string[]
  focusedProject: string | null
  focusedTerminal: string | null
}

export async function jevDecide(
  spoken: string,
  context: JevContext,
  apiKey: string,
  model?: string,
): Promise<JevDecision> {
  return invoke<JevDecision>('jev_decide', { spoken, context, apiKey, native: false, model })
}
