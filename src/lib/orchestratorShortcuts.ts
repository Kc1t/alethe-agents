import type { TFunction } from './i18n'
import type { OrchestratorJob } from './tauri/orchestrator'
import type { OrchestratorShortcut } from './types'

/** The branch `alethe_delegate` gives an isolated worker, which the planner merges to apply it. */
export function workerBranch(jobId: string): string {
  return `alethe/agent-${jobId}`
}

/** Alethe's own shortcuts. Their text lives in the locale files, so they arrive translated. */
export function builtinShortcuts(t: TFunction): OrchestratorShortcut[] {
  return [
    {
      id: 'apply',
      name: t('orchestrator.shortcut.applyName'),
      text: t('orchestrator.shortcut.applyText'),
      rule: 'finishedIsolated',
    },
    {
      id: 'review',
      name: t('orchestrator.shortcut.reviewName'),
      text: t('orchestrator.shortcut.reviewText'),
      rule: 'finished',
    },
    {
      id: 'continue',
      name: t('orchestrator.shortcut.continueName'),
      text: t('orchestrator.shortcut.continueText'),
      rule: 'any',
    },
  ]
}

export function resolveShortcuts(
  stored: OrchestratorShortcut[] | null | undefined,
  t: TFunction,
): OrchestratorShortcut[] {
  return stored == null ? builtinShortcuts(t) : stored
}

function matches(rule: OrchestratorShortcut['rule'], job: OrchestratorJob): boolean {
  if (rule === 'any') return true
  if (job.status !== 'done') return false
  return rule === 'finished' || job.worktree !== null
}

/**
 * A native subagent gets none: it has no backend job, so there is nothing for the planner to act on.
 */
export function shortcutsForJob(
  shortcuts: readonly OrchestratorShortcut[],
  job: OrchestratorJob,
): OrchestratorShortcut[] {
  if (job.native) return []
  return shortcuts.filter((shortcut) => matches(shortcut.rule, job))
}

export function renderShortcut(
  shortcut: OrchestratorShortcut,
  job: OrchestratorJob,
  projectCwd: string | null,
): string {
  const values: Record<string, string> = {
    jobId: job.id,
    agent: job.agent,
    branch: workerBranch(job.id),
    worktree: job.worktree ?? '',
    project: projectCwd ?? '',
  }
  return shortcut.text.replace(/\{(jobId|agent|branch|worktree|project)\}/g, (_, key: string) =>
    values[key] ?? '',
  )
}
