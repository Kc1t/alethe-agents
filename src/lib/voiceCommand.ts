/**
 * Turns one Jev decision into a workspace plan.
 *
 * Kept free of store and Tauri imports so the routing rules can be unit tested on their own.
 */

import type { MessageKey } from './i18n'
import type { JevAnswer, JevContext, JevDecision } from './tauri/jev'
import type { AgentType } from './types'

export const VOICE_THRESHOLDS = {
  addressed: 0.5,
  action: 0.45,
  project: 0.6,
  terminal: 0.6,
  agent: 0.6,
  prompt: 0.4,
  destructive: 0.6,
} as const

export const NONE = 'none'

export type VoiceProject = {
  id: string
  name: string
  path: string
}

export type VoiceTerminal = {
  id: string
  projectId: string
  projectName: string
  ptyId: string | null
  agent: AgentType
  cwd: string
  busy: boolean
  name: string
}

export type VoiceWorkspace = {
  projects: VoiceProject[]
  terminals: VoiceTerminal[]
  agents: AgentType[]
  focusedProjectId: string | null
  focusedTerminalId: string | null
}

export type VoiceBlock =
  | 'notACommand'
  | 'unclearAction'
  | 'needsFolder'
  | 'noProject'
  | 'noTerminal'
  | 'noLiveTerminal'
  | 'noPrompt'

export interface VoiceJob {
  agent: AgentType
  prompt: string
}

export type VoicePlan =
  | {
      kind: 'spawn'
      projectId: string
      projectName: string
      jobs: VoiceJob[]
    }
  | {
      kind: 'reuse'
      projectId: string
      terminalId: string
      terminalName: string
      ptyId: string
      prompt: string
    }
  | { kind: 'focus'; projectId: string; terminalId: string; terminalName: string }
  | { kind: 'kill'; projectId: string; terminalId: string; terminalName: string }
  | { kind: 'blocked'; reason: VoiceBlock }

export function toJevContext(workspace: VoiceWorkspace): JevContext {
  return {
    projects: workspace.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
    })),
    terminals: workspace.terminals.map((terminal, index) => ({
      id: terminal.id,
      project: terminal.projectName,
      agent: String(terminal.agent),
      cwd: terminal.cwd,
      busy: terminal.busy,
      name: terminal.name,
      ordinal: index + 1,
    })),
    agents: workspace.agents.map(String),
    focusedProject: workspace.focusedProjectId,
    focusedTerminal: workspace.focusedTerminalId,
  }
}

function pickTerminal(
  decision: JevDecision,
  workspace: VoiceWorkspace,
  fallbackToFocused: boolean,
): VoiceTerminal | null {
  const chosen = decision.terminal
  if (chosen.choice !== NONE && chosen.confidence >= VOICE_THRESHOLDS.terminal) {
    const match = workspace.terminals.find((terminal) => terminal.id === chosen.choice)
    if (match) return match
  }
  if (!fallbackToFocused || !workspace.focusedTerminalId) return null
  return workspace.terminals.find((t) => t.id === workspace.focusedTerminalId) ?? null
}

function pickProject(
  decision: JevDecision,
  workspace: VoiceWorkspace,
  hint: VoiceTerminal | null,
): VoiceProject | null {
  const chosen = decision.project
  if (chosen.choice !== NONE && chosen.confidence >= VOICE_THRESHOLDS.project) {
    const match = workspace.projects.find((project) => project.id === chosen.choice)
    if (match) return match
  }
  const fallbackId = hint?.projectId ?? workspace.focusedProjectId
  if (!fallbackId) return null
  return workspace.projects.find((project) => project.id === fallbackId) ?? null
}

const AGENT_FALLBACK_ORDER: AgentType[] = ['claude', 'codex', 'copilot', 'cursor', 'opencode']

function resolveAgent(chosen: JevAnswer, workspace: VoiceWorkspace): AgentType {
  if (chosen.choice !== NONE && chosen.confidence >= VOICE_THRESHOLDS.agent) {
    const match = workspace.agents.find((agent) => agent === chosen.choice)
    if (match) return match
  }
  const preferred = AGENT_FALLBACK_ORDER.find((agent) => workspace.agents.includes(agent))
  return preferred ?? workspace.agents[0] ?? 'claude'
}

function jobsFor(decision: JevDecision, workspace: VoiceWorkspace, prompt: string): VoiceJob[] {
  const extra = decision.tasks.filter((task) => {
    const namedAgent = task.agent.choice !== NONE && task.agent.confidence >= VOICE_THRESHOLDS.agent
    const ownTask =
      task.promptConfidence >= VOICE_THRESHOLDS.prompt && task.prompt.trim() !== prompt
    return namedAgent || ownTask
  })
  if (extra.length > 0) {
    const lead: VoiceJob = { agent: resolveAgent(decision.agent, workspace), prompt }
    const jobs = repeat(lead, copies(decision.leadCount))
    for (const task of extra) {
      const job: VoiceJob = {
        agent: resolveAgent(task.agent, workspace),
        prompt: task.promptConfidence >= VOICE_THRESHOLDS.prompt ? task.prompt.trim() : lead.prompt,
      }
      jobs.push(...repeat(job, copies(task.count)))
    }
    return jobs
  }
  const agent = resolveAgent(decision.agent, workspace)
  return Array.from({ length: agentCount(decision) }, () => ({ agent, prompt }))
}

function copies(score: number): number {
  if (score >= 0.67) return 3
  if (score >= 0.34) return 2
  return 1
}

function repeat(job: VoiceJob, times: number): VoiceJob[] {
  return Array.from({ length: times }, () => ({ ...job }))
}

function agentCount(decision: JevDecision): number {
  if (decision.parallel <= 0.5) return 1
  if (decision.howMany >= 0.67) return 3
  return 2
}

function promptOf(decision: JevDecision): string {
  if (decision.promptConfidence < VOICE_THRESHOLDS.prompt) return ''
  return decision.prompt.trim()
}

export function planFromDecision(decision: JevDecision, workspace: VoiceWorkspace): VoicePlan {
  if (decision.addressedToApp < VOICE_THRESHOLDS.addressed) {
    return { kind: 'blocked', reason: 'notACommand' }
  }
  if (decision.action.confidence < VOICE_THRESHOLDS.action) {
    return { kind: 'blocked', reason: 'unclearAction' }
  }

  const prompt = promptOf(decision)

  switch (decision.action.choice) {
    case 'nothing':
    case NONE:
      return { kind: 'blocked', reason: 'notACommand' }

    case 'new_project':
      return { kind: 'blocked', reason: 'needsFolder' }

    case 'kill_terminal':
    case 'focus_terminal': {
      const terminal = pickTerminal(decision, workspace, true)
      if (!terminal) return { kind: 'blocked', reason: 'noTerminal' }
      return {
        kind: decision.action.choice === 'kill_terminal' ? 'kill' : 'focus',
        projectId: terminal.projectId,
        terminalId: terminal.id,
        terminalName: `${terminal.agent} · ${terminal.projectName}`,
      }
    }

    case 'send_prompt':
    case 'reuse_terminal': {
      const terminal = pickTerminal(decision, workspace, true)
      if (!terminal) return { kind: 'blocked', reason: 'noTerminal' }
      if (!terminal.ptyId) return { kind: 'blocked', reason: 'noLiveTerminal' }
      if (!prompt) return { kind: 'blocked', reason: 'noPrompt' }
      return {
        kind: 'reuse',
        projectId: terminal.projectId,
        terminalId: terminal.id,
        terminalName: `${terminal.agent} · ${terminal.projectName}`,
        ptyId: terminal.ptyId,
        prompt,
      }
    }

    default: {
      const hint = pickTerminal(decision, workspace, false)
      const project = pickProject(decision, workspace, hint)
      if (!project) return { kind: 'blocked', reason: 'noProject' }
      return {
        kind: 'spawn',
        projectId: project.id,
        projectName: project.name,
        jobs: jobsFor(decision, workspace, prompt),
      }
    }
  }
}

export const BLOCK_REASONS: Record<VoiceBlock, MessageKey> = {
  notACommand: 'voice.block.notACommand',
  unclearAction: 'voice.block.unclearAction',
  needsFolder: 'voice.block.needsFolder',
  noProject: 'voice.block.noProject',
  noTerminal: 'voice.block.noTerminal',
  noLiveTerminal: 'voice.block.noLiveTerminal',
  noPrompt: 'voice.block.noPrompt',
}

export function needsConfirmation(plan: VoicePlan, warnings: readonly VoiceWarning[]): boolean {
  if (plan.kind === 'kill') return true
  if (warnings.includes('destructive')) return true
  return plan.kind === 'reuse' && warnings.includes('busyTerminal')
}

export type VoiceWarning =
  'destructive' | 'busyTerminal' | 'noPromptSpawn' | 'lowPrompt' | 'sharedPrompt'

export const WARNINGS: Record<VoiceWarning, MessageKey> = {
  destructive: 'voice.warn.destructive',
  busyTerminal: 'voice.warn.busyTerminal',
  noPromptSpawn: 'voice.warn.noPromptSpawn',
  lowPrompt: 'voice.warn.lowPrompt',
  sharedPrompt: 'voice.warn.sharedPrompt',
}

export function planWarnings(
  decision: JevDecision,
  plan: VoicePlan,
  workspace: VoiceWorkspace,
): VoiceWarning[] {
  const warnings: VoiceWarning[] = []
  if (decision.destructive > VOICE_THRESHOLDS.destructive) warnings.push('destructive')
  if (plan.kind === 'reuse') {
    const terminal = workspace.terminals.find((item) => item.id === plan.terminalId)
    if (terminal?.busy) warnings.push('busyTerminal')
  }
  if (plan.kind === 'spawn') {
    const prompts = plan.jobs.map((job) => job.prompt)
    if (prompts.every((prompt) => !prompt)) warnings.push('noPromptSpawn')
    else if (prompts.length > 1 && new Set(prompts).size === 1) warnings.push('sharedPrompt')
  }
  if (
    decision.prompt.trim() &&
    decision.promptConfidence < VOICE_THRESHOLDS.prompt &&
    plan.kind !== 'blocked'
  ) {
    warnings.push('lowPrompt')
  }
  return warnings
}
