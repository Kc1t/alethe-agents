import { useProjectsStore } from '../stores/projectsStore'
import { getLocale, translate } from './i18n'
import { notifyLimitReset } from './notifications'
import type { ClaudeUsage, CodexUsage } from './tauri'
import type { AgentType } from './types'

type WindowKind = '5h' | 'week' | 'opus'
type Entry = { resetsAt: number; notified: boolean; agent: AgentType; kind: WindowKind }

const entries = new Map<string, Entry>()
const HEARTBEAT_MS = 60_000

const RESET_ROLLOVER_GRACE_MS = 5 * 60_000
let heartbeat: number | null = null

function agentLabel(agent: AgentType): string {
  return agent === 'codex' ? 'Codex' : 'Claude'
}

function windowLabel(kind: WindowKind): string {
  if (kind === 'week') return translate(getLocale(), 'widget.week')
  return kind // '5h' | 'opus'
}

function fire(entry: Entry): void {
  if (!useProjectsStore.getState().preferences.notifyOnLimitReset) return
  const locale = getLocale()
  void notifyLimitReset(
    translate(locale, 'notif.limitResetTitle'),
    translate(locale, 'notif.limitResetBody', {
      agent: agentLabel(entry.agent),
      window: windowLabel(entry.kind),
    }),
    entry.agent,
  )
}

function ensureHeartbeat(): void {
  if (heartbeat !== null) return
  heartbeat = window.setInterval(() => {
    const now = Date.now()
    for (const entry of entries.values()) {
      if (!entry.notified && now >= entry.resetsAt) {
        fire(entry)
        entry.notified = true
      }
    }
  }, HEARTBEAT_MS)
}

function observe(key: string, agent: AgentType, kind: WindowKind, resetsAt: number): void {
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return
  ensureHeartbeat()
  const prev = entries.get(key)
  if (!prev) {
    entries.set(key, { resetsAt, notified: false, agent, kind })
    return
  }
  if (resetsAt > prev.resetsAt) {
    if (prev.resetsAt <= Date.now() + RESET_ROLLOVER_GRACE_MS && !prev.notified) {
      fire(prev)
    }
    entries.set(key, { resetsAt, notified: false, agent, kind })
  }

  // resetsAt < prev.resetsAt: dado mais velho (cache), ignora.
}

function parseIso(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

export function observeClaudeReset(usage: ClaudeUsage): void {
  observe('claude:5h', 'claude', '5h', parseIso(usage.five_hour.resets_at))
  observe('claude:week', 'claude', 'week', parseIso(usage.seven_day.resets_at))
  observe('claude:opus', 'claude', 'opus', parseIso(usage.seven_day_opus.resets_at))
}

export function observeCodexReset(usage: CodexUsage): void {
  observe('codex:5h', 'codex', '5h', usage.primary.resets_at_ms)
  observe('codex:week', 'codex', 'week', usage.secondary.resets_at_ms)
}
