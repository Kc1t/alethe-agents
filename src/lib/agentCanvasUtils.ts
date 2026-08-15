/** Pure Agent Canvas helpers and types. */
import {
  Bot,
  LayoutTemplate,
  type LucideIcon,
  Paintbrush,
  PenLine,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'

import type { AgentNode } from '../stores/agentCanvasStore'
import { AGENT_COLORS, FAMILY_RANK } from './agentCanvasConfig'
import { costLevel, shortModel } from './costFormat'
import type { ModelRate, SessionCost } from './tauri'
import type { AgentType } from './types'

/** CSS module class map. */
export type CanvasStyleMap = Readonly<Record<string, string>>

/** SVG edge connecting the control plane to a card or task. */
export type Edge = { id: string; x1: number; y1: number; x2: number; y2: number; done: boolean }

/** Real PTY worker managed by the canvas and expandable into a full terminal. */
export type CodexWorker = {
  ptyId: string
  /** Process agent (claude, codex, or opencode). */
  agent: AgentType
  /** Worker task or origin. */
  title: string
  cwd: string
  startedAt: number
  exitedCode: number | null
  /** One-shot agent arguments; undefined for interactive mode. */
  args?: string[]
  /** Tail summary of the worker output. */
  result?: string
}

/** Format the time until a usage window resets. */
export function formatReset(resetsAt: string, nowLabel = 'agora'): string {
  if (!resetsAt) return '—'
  const diff = new Date(resetsAt).getTime() - Date.now()
  if (Number.isNaN(diff)) return '—'
  if (diff <= 0) return nowLabel
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

/** Build the single-line orchestration prompt for the lead session. */
// Keep this argument free of quotes, backticks, and newlines for Windows batch parsing.
export function orchestrationRules(agentEndpoint: string, budgetUsd?: number | null) {
  const budget =
    budgetUsd && budgetUsd > 0
      ? ` Budget ceiling for this session is about ${budgetUsd} US dollars; prefer cheap routing and pause to ask the user before exceeding it.`
      : ''
  return (
    'You are the autonomous control plane and brain of an Alethe agent canvas session. The user gives you a high level goal in this terminal and you drive it to done by distributing the work across AIs, watching their results, and deciding each next action yourself. Work autonomously but with checkpoints. Rules: ' +
    '(1) For a small task just do it solo; spawning agents has overhead. ' +
    '(2) For a large goal such as building a feature or a small app, FIRST consult the orchestrator agent if it exists (Agent tool, subagent_type orchestrator) to get a plan: parallel streams for front, back, qa and docs, plus a task list with dependencies and a suggested agent per task; if no orchestrator agent is available, draft that plan yourself. Present the plan to the user and wait for approval before executing. ' +
    '(3) After approval, create a SMALL agent team (2 to 4 teammates, never more) and give each teammate distinct file paths so two never edit the same file; put full context in each spawn prompt; break the work into tasks with dependencies; then coordinate and wait for your teammates instead of implementing everything yourself. ' +
    '(4) Route by cost: if cheap workers exist in .claude/agents, use haiku-resumidor for bulk reading and summarizing, haiku-mecanico for well specified mechanical edits, codex-executor for long noisy execution; keep architecture and ambiguous work on capable models; never route ambiguous work to cheap workers; prefer offloading to a codex worker when Claude usage is high. ' +
    '(5) Checkpoints: pause and ask the user at big milestones such as the end of an epic, before destructive or irreversible steps, and whenever spending approaches the budget ceiling; never exceed the ceiling without asking. Integrate the streams and run qa before declaring done. ' +
    `(6) Real workers are EXPENSIVE: each spawn is a full separate process using hundreds of megabytes of RAM, so prefer in-process subagents and teammates for almost everything, spawn AT MOST two real workers at a time, reuse them instead of respawning, and prefer a codex worker over a claude worker because codex is far lighter. To spawn one, POST JSON to ${agentEndpoint}/spawn with body {agent, task, mode}: agent is claude, codex or opencode; task is one self contained English instruction; mode is exec for one shot fire and forget or interactive. Use curl -s -X POST with the -d flag and single quoted JSON. It is fire and forget: you do not get the output back, so use it only for offloadable work, not results you must read.` +
    budget
  )
}

/** Return a stable color for an agent type. */
export function colorFor(agentType: string): string {
  const known = AGENT_COLORS[agentType.toLowerCase()]
  if (known) return known
  // Custom agents and teammates use a stable name hash.
  let h = 0
  for (const ch of agentType) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 55% 62%)`
}

/** Format a completed node duration; return null while it is running. */
export function durationLabel(node: { startedAt: number; endedAt: number | null }): string | null {
  if (node.endedAt === null) return null
  const s = Math.round((node.endedAt - node.startedAt) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

/** Strip terminal control sequences and return the tail of a worker's output. */
export function tailSummary(raw: string, max = 320): string {
  const clean = raw
    // CSI: ESC [ ... letra final
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    // OSC: ESC ] ... (BEL ou ESC backslash)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // outros escapes ESC de 1 char
    .replace(/\x1b[@-Z\\-_]/g, '')
                                                     
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return clean.length > max ? `…${clean.slice(-max)}` : clean
}

                                                                                     
export function execArgsFor(agent: AgentType, task: string): string[] | undefined {
  switch (agent) {
    case 'codex':
      return ['exec', '--skip-git-repo-check', task]
    case 'claude':
                                                                                 
      return ['-p', task, '--dangerously-skip-permissions']
    case 'opencode':
      return ['run', task]
    default:
      return undefined
  }
}

                                                           
export function statusBadgeClass(status: AgentNode['status'], styles: CanvasStyleMap): string {
  if (status === 'running') return styles.statusRunning
  if (status === 'idle') return styles.statusIdle
  return styles.statusDone
}

/** Faixa de gasto (USD) → classe de cor do canvas (tokens do tema). */
export function costClassFor(usd: number, styles: CanvasStyleMap): string {
  const level = costLevel(usd)
  if (level === 'high') return styles.costHigh
  if (level === 'mid') return styles.costMid
  return styles.costLow
}

                                                                               
export function costAtRate(c: SessionCost, rate: ModelRate): number {
  return (
    (c.input * rate.input +
      c.output * rate.output +
      c.cache_read * rate.cache_read +
      c.cache_write_5m * rate.cache_write_5m +
      c.cache_write_1h * rate.cache_write_1h) /
    1_000_000
  )
}

   
                                                                             
                                                                     
                                                                                
                                                                         
   
export function estimateRoutingSavings(
  nodeCosts: Record<string, SessionCost>,
  leadModel: string | null,
  pricing: ModelRate[],
): number {
  const leadFamily = shortModel(leadModel)
  if (!leadFamily) return 0
  const leadRate = pricing.find((r) => r.family === leadFamily) ?? null
  const leadRank = FAMILY_RANK[leadFamily] ?? 0
  if (!leadRate || leadRank === 0) return 0
  let saved = 0
  for (const c of Object.values(nodeCosts)) {
    if (c.cost_usd == null) continue
    const fam = shortModel(c.model)
    const rank = fam ? (FAMILY_RANK[fam] ?? 0) : 0
    if (rank === 0 || rank >= leadRank) continue
    const delta = costAtRate(c, leadRate) - c.cost_usd
    if (delta > 0) saved += delta
  }
  return saved
}

                                                         
export function personaIconFor(agentName: string): LucideIcon {
  const name = agentName.toLowerCase()
  if (name.includes('orchestr') || name.includes('tech-lead')) return LayoutTemplate
  if (name.includes('frontend')) return Paintbrush
  if (name.includes('backend')) return Server
  if (name.includes('qa') || name.includes('review')) return ShieldCheck
  if (name.includes('docs') || name.includes('writer')) return PenLine
  if (name.includes('codex') || name.includes('executor')) return TerminalSquare
  if (name.includes('plan')) return LayoutTemplate
  return Bot
}
