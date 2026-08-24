import { describe, expect, it } from 'vitest'

import { countLanes, groupPlanners, groupRuns, worstState } from './orchestratorRuns'
import type { OrchestratorJob, OrchestratorPlanner } from './tauri'

function job(
  partial: Partial<OrchestratorJob> & Pick<OrchestratorJob, 'id' | 'runId'>,
): OrchestratorJob {
  return {
    plannerId: null,
    agent: 'codex',
    runLabel: null,
    spec: 'spec',
    cwd: 'C:/repo',
    status: 'running',
    threadId: null,
    outcome: null,
    seconds: null,
    plan: [],
    tokens: null,
    worktree: null,
    hasDiff: false,
    summary: '',
    ...partial,
  }
}

describe('groupRuns', () => {
  it('groups jobs by run id, keeping first-seen order', () => {
    const runs = groupRuns([
      job({ id: 'job-01', runId: 'run-b' }),
      job({ id: 'job-02', runId: 'run-a' }),
      job({ id: 'job-03', runId: 'run-b' }),
    ])

    expect(runs.map((run) => run.id)).toEqual(['run-b', 'run-a'])
    expect(runs[0].jobs.map((entry) => entry.id)).toEqual(['job-01', 'job-03'])
  })

  it('falls back to the run id when no worker carries a label', () => {
    const [run] = groupRuns([job({ id: 'job-01', runId: 'run-a' })])
    expect(run.label).toBe('run-a')
  })

  it('takes the label from the first worker that has one', () => {
    const [run] = groupRuns([
      job({ id: 'job-01', runId: 'run-a', runLabel: '   ' }),
      job({ id: 'job-02', runId: 'run-a', runLabel: ' refactor pty ' }),
    ])
    expect(run.label).toBe('refactor pty')
  })

  it('reports the worst state among the workers of a run', () => {
    const [run] = groupRuns([
      job({ id: 'job-01', runId: 'run-a', status: 'done' }),
      job({ id: 'job-02', runId: 'run-a', status: 'running' }),
      job({ id: 'job-03', runId: 'run-a', status: 'failed' }),
    ])

    expect(run.state).toBe('failed')
    expect(run.counts).toEqual({ running: 1, queued: 0, interrupted: 0, failed: 1, finished: 1 })
  })

  it('ranks running above queued and queued above finished', () => {
    expect(worstState(countLanes([job({ id: 'a', runId: 'r', status: 'queued' })]))).toBe('queued')
    expect(
      worstState(
        countLanes([
          job({ id: 'a', runId: 'r', status: 'queued' }),
          job({ id: 'b', runId: 'r', status: 'running' }),
        ]),
      ),
    ).toBe('running')
    expect(
      worstState(
        countLanes([
          job({ id: 'a', runId: 'r', status: 'cancelled' }),
          job({ id: 'b', runId: 'r', status: 'released' }),
        ]),
      ),
    ).toBe('finished')
  })

  it('keeps interrupted work in its own lane, above the live workers', () => {
    const [run] = groupRuns([
      job({ id: 'job-01', runId: 'run-a', status: 'running' }),
      job({ id: 'job-02', runId: 'run-a', status: 'interrupted' }),
    ])

    expect(run.state).toBe('interrupted')
    expect(run.counts).toEqual({
      running: 1,
      queued: 0,
      interrupted: 1,
      failed: 0,
      finished: 0,
    })
  })

  it('still reads as failed when a run has both a failure and interrupted work', () => {
    const [run] = groupRuns([
      job({ id: 'job-01', runId: 'run-a', status: 'interrupted' }),
      job({ id: 'job-02', runId: 'run-a', status: 'failed' }),
    ])

    expect(run.state).toBe('failed')
  })

  it('has no state to report for an empty run', () => {
    expect(groupRuns([])).toEqual([])
  })
})

function planner(id: string, label: string, agent = 'claude'): OrchestratorPlanner {
  return { id, label, agent }
}

describe('groupPlanners', () => {
  it('makes one group per declared planner, ordered by label', () => {
    const groups = groupPlanners(
      [job({ id: 'job-01', runId: 'run-a', plannerId: 'pty-2' })],
      [planner('pty-2', 'refactor pty'), planner('pty-1', 'migrate CI')],
    )

    expect(groups.map((group) => group.id)).toEqual(['pty-1', 'pty-2'])
    expect(groups.map((group) => group.label)).toEqual(['migrate CI', 'refactor pty'])
    expect(groups.map((group) => group.agent)).toEqual(['claude', 'claude'])
  })

  it('keeps a declared planner that has delegated nothing', () => {
    const [group] = groupPlanners([], [planner('pty-1', 'migrate CI')])

    expect(group).toMatchObject({ id: 'pty-1', label: 'migrate CI', state: 'finished' })
    expect(group.runs).toEqual([])
    expect(group.jobs).toEqual([])
    expect(group.counts).toEqual({ running: 0, queued: 0, interrupted: 0, failed: 0, finished: 0 })
  })

  it('groups every run of a planner under its own tab', () => {
    const [group] = groupPlanners(
      [
        job({ id: 'job-01', runId: 'run-a', plannerId: 'pty-1' }),
        job({ id: 'job-02', runId: 'run-b', plannerId: 'pty-1' }),
        job({ id: 'job-03', runId: 'run-a', plannerId: 'pty-1' }),
      ],
      [planner('pty-1', 'refactor pty')],
    )

    expect(group.runs.map((run) => run.id)).toEqual(['run-a', 'run-b'])
    expect(group.runs[0].jobs.map((entry) => entry.id)).toEqual(['job-01', 'job-03'])
    expect(group.jobs).toHaveLength(3)
  })

  it('puts the jobs with no planner in a last unlabelled group', () => {
    const groups = groupPlanners(
      [
        job({ id: 'job-01', runId: 'run-a', plannerId: null }),
        job({ id: 'job-02', runId: 'run-b', plannerId: 'pty-1' }),
      ],
      [planner('pty-1', 'refactor pty')],
    )

    expect(groups.map((group) => group.id)).toEqual(['pty-1', null])
    expect(groups[1]).toMatchObject({ label: null, agent: null })
    expect(groups[1].jobs.map((entry) => entry.id)).toEqual(['job-01'])
  })

  it('never drops jobs whose planner is no longer declared', () => {
    const groups = groupPlanners(
      [
        job({ id: 'job-01', runId: 'run-a', plannerId: 'pty-gone' }),
        job({ id: 'job-02', runId: 'run-b', plannerId: null }),
      ],
      [],
    )

    expect(groups.map((group) => group.id)).toEqual(['pty-gone', null])
    expect(groups[0]).toMatchObject({ label: 'pty-gone', agent: null })
  })

  it('reports the worst state across every run of the planner', () => {
    const [group] = groupPlanners(
      [
        job({ id: 'job-01', runId: 'run-a', plannerId: 'pty-1', status: 'done' }),
        job({ id: 'job-02', runId: 'run-b', plannerId: 'pty-1', status: 'failed' }),
      ],
      [planner('pty-1', 'refactor pty')],
    )

    expect(group.state).toBe('failed')
    expect(group.counts).toEqual({ running: 0, queued: 0, interrupted: 0, failed: 1, finished: 1 })
  })

  it('falls back to the planner id when the terminal has no usable name', () => {
    const [group] = groupPlanners([], [planner('pty-1', '   ', '  ')])
    expect(group).toMatchObject({ label: 'pty-1', agent: null })
  })

  it('has nothing to show without planners or jobs', () => {
    expect(groupPlanners([], [])).toEqual([])
  })
})
