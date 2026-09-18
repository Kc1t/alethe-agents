import { Cpu } from 'lucide-react'

import { parseAgentType } from '../../lib/agentProviders'
import type { TFunction } from '../../lib/i18n'
import type { OrchestratorJob } from '../../lib/tauri/orchestrator'
import type { Theme } from '../../lib/types'
import { AgentIcon } from '../icons/AgentIcons'

/** Shared by the canvas nodes and the inspector panel, so both read a worker the same way. */
export function formatElapsed(seconds: number | null): string | null {
  if (seconds === null) return null
  const whole = Math.floor(seconds)
  if (whole < 60) return `${whole}s`
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`
}

export function formatTokens(total: number | undefined): string | null {
  if (!total) return null
  if (total < 1000) return `${total}`
  return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
}

export function contextShare(job: OrchestratorJob): number | null {
  const used = job.tokens?.total?.totalTokens
  const window = job.tokens?.modelContextWindow
  if (!used || !window) return null
  return Math.min(100, Math.round((used / window) * 100))
}

export function statusTitle(status: OrchestratorJob['status'], t: TFunction): string | undefined {
  if (status === 'interrupted') return t('orchestrator.interruptedTitle')
  if (status === 'blocked') return t('orchestrator.blockedTitle')
  return undefined
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return ''
  }
}

/** A diff viewer's line classifier; each caller supplies its own CSS module's class names. */
export type DiffLineStyles = { readonly [key: string]: string }

export function diffLineClass(line: string, styles: DiffLineStyles): string | undefined {
  if (line.startsWith('+') && !line.startsWith('+++')) return styles.diffAdded
  if (line.startsWith('-') && !line.startsWith('---')) return styles.diffRemoved
  if (line.startsWith('@@ ')) return styles.diffHunk
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return styles.diffHeaderLine
  }
  return undefined
}

export type AgentGlyphProps = {
  agent: string | null
  theme: Theme
  size?: number
  title?: string
  /** The caller's own CSS module class for the glyph wrapper (`.glyph` in both consumers today). */
  className: string
}

export function AgentGlyph({ agent, theme, size = 15, title, className }: AgentGlyphProps) {
  const type = parseAgentType(agent)
  return (
    <span className={className} title={title} aria-hidden>
      {type ? <AgentIcon type={type} size={size} theme={theme} /> : <Cpu size={size} />}
    </span>
  )
}
