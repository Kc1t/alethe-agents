import { describe, expect, it } from 'vitest'

import { groupAgentJobs, NO_PROJECT_KEY, projectForCwd, sumJobCost } from './agentsPanelGroups'
import type { OrchestratorJob } from './tauri/orchestrator'
import type { Project, Terminal } from './types'

function terminal(id: string, cwd: string, ptyId: string | null): Terminal {
  return {
    id,
    name: id,
    cwd,
    tabs: [{ id: `${id}-tab`, type: 'claude', name: id, cwd, ptyId }],
    activeTabId: `${id}-tab`,
    disabled: false,
    laneVisible: true,
    lastUsedAt: 0,
  } as Terminal
}

function project(id: string, cwd: string, terminals: Terminal[] = []): Project {
  return {
    id,
    name: id,
    groupId: null,
    defaultCwd: cwd,
    terminals,
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 0,
  } as Project
}

function job(partial: Partial<OrchestratorJob>): OrchestratorJob {
  return {
    id: 'job',
    plannerId: null,
    agent: 'codex',
    runId: 'run',
    runLabel: null,
    rules: null,
    spec: 'task',
    cwd: '',
    status: 'running',
    threadId: null,
    outcome: null,
    seconds: null,
    plan: [],
    tokens: null,
    costUsd: null,
    quota: null,
    routing: null,
    worktree: null,
    role: null,
    model: null,
    effort: null,
    readOnly: false,
    pendingApproval: null,
    hasDiff: false,
    summary: '',
    ...partial,
  }
}

describe('projectForCwd', () => {
  it('picks the deepest project root that contains the path', () => {
    const outer = project('outer', 'C:\\repo')
    const inner = project('inner', 'C:\\repo\\packages\\api')
    expect(projectForCwd([outer, inner], 'c:/repo/packages/api/src')?.id).toBe('inner')
    expect(projectForCwd([outer, inner], 'C:\\repo\\docs')?.id).toBe('outer')
  })

  it('does not match a sibling folder that only shares a prefix', () => {
    expect(projectForCwd([project('repo', 'C:\\repo')], 'C:\\repo-two')).toBeNull()
  })
})

describe('groupAgentJobs', () => {
  it('buckets by the planner terminal first and by cwd when the planner is unknown', () => {
    const app = project('app', 'C:\\app', [terminal('t1', 'C:\\app', 'pty-1')])
    const web = project('web', 'C:\\web')
    const groups = groupAgentJobs(
      [
        job({ id: 'a', plannerId: 'pty-1', cwd: 'C:\\web' }),
        job({ id: 'b', plannerId: 'pty-gone', cwd: 'C:\\web\\src' }),
        job({ id: 'c', cwd: 'D:\\nowhere' }),
      ],
      [app, web],
      [{ id: 'pty-gone', label: 'Old planner', agent: 'codex' }],
      null,
    )

    expect(groups.map((group) => group.key)).toEqual(['app', 'web', NO_PROJECT_KEY])
    expect(groups[0].planners[0].terminal?.id).toBe('t1')
    expect(groups[0].planners[0].agent).toBe('claude')
    expect(groups[1].planners[0].label).toBe('Old planner')
    expect(groups[1].planners[0].agent).toBe('codex')
  })

  it('puts the active project first and splits finished work from live work', () => {
    const groups = groupAgentJobs(
      [
        job({ id: 'a', cwd: 'C:\\a' }),
        job({ id: 'b', cwd: 'C:\\b', status: 'done' }),
        job({ id: 'c', cwd: 'C:\\b', status: 'blocked' }),
        job({ id: 'd', cwd: 'C:\\b', status: 'queued' }),
      ],
      [project('a', 'C:\\a'), project('b', 'C:\\b')],
      [],
      'b',
    )

    expect(groups.map((group) => group.key)).toEqual(['b', 'a'])
    const planner = groups[0].planners[0]
    expect(planner.active.map((entry) => entry.id)).toEqual(['c', 'd'])
    expect(planner.finished.map((entry) => entry.id)).toEqual(['b'])
    expect(groups[0].waiting).toBe(1)
    expect(groups[1].running).toBe(1)
  })
})

describe('sumJobCost', () => {
  it('is null when no worker reports a price', () => {
    expect(sumJobCost([job({}), job({ id: 'b' })])).toBeNull()
    expect(
      sumJobCost([job({ costUsd: 0.5 }), job({ id: 'b', costUsd: 1 }), job({ id: 'c' })]),
    ).toBe(1.5)
  })
})
