import { describe, expect, it } from 'vitest'

import type { TFunction } from './i18n'
import {
  builtinShortcuts,
  renderShortcut,
  resolveShortcuts,
  shortcutsForJob,
  workerBranch,
} from './orchestratorShortcuts'
import type { OrchestratorJob } from './tauri/orchestrator'

const t = ((key: string) => key) as unknown as TFunction

const job = (patch: Partial<OrchestratorJob> = {}): OrchestratorJob =>
  ({
    id: 'job-03',
    plannerId: 'p1',
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    rules: null,
    spec: 'do the thing',
    cwd: 'C:\\app',
    status: 'done',
    threadId: null,
    outcome: null,
    seconds: 12,
    plan: [],
    tokens: null,
    quota: null,
    routing: null,
    worktree: 'C:\\app',
    pendingApproval: null,
    hasDiff: true,
    summary: 'done',
    ...patch,
  }) as OrchestratorJob

describe('shortcutsForJob', () => {
  const shortcuts = builtinShortcuts(t)

  it('offers apply only to an isolated worker that finished', () => {
    const ids = shortcutsForJob(shortcuts, job()).map((s) => s.id)
    expect(ids).toContain('apply')

    const noWorktree = shortcutsForJob(shortcuts, job({ worktree: null })).map((s) => s.id)
    expect(noWorktree).not.toContain('apply')

    const running = shortcutsForJob(shortcuts, job({ status: 'running' })).map((s) => s.id)
    expect(running).not.toContain('apply')
    expect(running).not.toContain('review')
    expect(running).toContain('continue')
  })

  it('offers nothing for a native subagent', () => {
    expect(shortcutsForJob(shortcuts, job({ native: true }))).toEqual([])
  })
})

describe('renderShortcut', () => {
  it('substitutes every placeholder', () => {
    const text = renderShortcut(
      { id: 'x', name: 'x', rule: 'any', text: '{jobId} {agent} {branch} {worktree} {project}' },
      job(),
      'C:\\project',
    )
    expect(text).toBe(`job-03 codex ${workerBranch('job-03')} C:\\app C:\\project`)
  })

  it('leaves no braces behind when a job has no worktree and no project', () => {
    const text = renderShortcut(
      { id: 'x', name: 'x', rule: 'any', text: '[{worktree}] [{project}]' },
      job({ worktree: null }),
      null,
    )
    expect(text).toBe('[] []')
  })
})

describe('resolveShortcuts', () => {
  it('falls back to the built-ins when nothing is stored', () => {
    expect(resolveShortcuts(undefined, t).map((s) => s.id)).toEqual(['apply', 'review', 'continue'])
    expect(resolveShortcuts(null, t).map((s) => s.id)).toEqual(['apply', 'review', 'continue'])
  })

  it('keeps what the person stored, even an empty list', () => {
    const stored = [{ id: 'mine', name: 'Mine', text: 'go', rule: 'any' as const }]
    expect(resolveShortcuts(stored, t)).toEqual(stored)
    expect(resolveShortcuts([], t)).toEqual([])
  })
})
