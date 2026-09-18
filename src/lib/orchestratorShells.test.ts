import { describe, expect, it } from 'vitest'

import type { OrchestratorShell } from './tauri/orchestrator'
import {
  isOrchestratorShellPty,
  plannerTabActivity,
  shellControls,
  shellIdOfPty,
  shellsForBoard,
  shellTerminalPlan,
  type BoardShell,
  type ShellAttachment,
} from './orchestratorShells'

function makeShell(overrides: Partial<OrchestratorShell> = {}): OrchestratorShell {
  return {
    id: 'shell-01',
    name: 'npm',
    command: 'npm run dev',
    cwd: 'C:\\proj',
    owner: null,
    status: 'running',
    exitCode: null,
    startedAtMs: 0,
    ptyId: 'orchestrator-shell-01',
    ...overrides,
  }
}

describe('orchestrator shells', () => {
  it('recognises the PTY of an orchestrator shell and only that', () => {
    expect(isOrchestratorShellPty('orchestrator-shell-01')).toBe(true)
    expect(isOrchestratorShellPty('V1StGXR8_Z5jdHi6B-myT')).toBe(false)
    expect(shellIdOfPty('orchestrator-shell-01')).toBe('shell-01')
  })

  it('offers stop, restart and open terminal while running, run again and remove otherwise', () => {
    expect(shellControls('running')).toEqual(['stop', 'restart', 'openTerminal'])
    expect(shellControls('exited')).toEqual(['play', 'remove'])
    expect(shellControls('stopped')).toEqual(['play', 'remove'])
  })
})

describe('shellsForBoard', () => {
  it("keeps the active planner's shells regardless of cwd", () => {
    const shell = makeShell({ id: 'a', owner: { kind: 'planner', id: 'p1' }, cwd: 'C:\\elsewhere' })
    const result = shellsForBoard([shell], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\proj',
    })
    expect(result).toEqual([{ ...shell, attachment: 'attached' as const }])
  })

  it("drops a shell that belongs to another live planner's tab", () => {
    const shell = makeShell({ id: 'b', owner: { kind: 'planner', id: 'p2' }, cwd: 'C:\\proj\\x' })
    const result = shellsForBoard([shell], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1', 'p2']),
      projectCwd: 'C:\\proj',
    })
    expect(result).toEqual([])
  })

  it('keeps an orphaned shell (its planner is gone) matched by cwd under the project', () => {
    const shell = makeShell({ id: 'c', owner: { kind: 'planner', id: 'p-gone' }, cwd: 'C:\\proj\\sub' })
    const result = shellsForBoard([shell], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\proj',
    })
    expect(result).toEqual([{ ...shell, attachment: 'detached' as const }])
  })

  it('keeps a plannerless shell matched by cwd under the project, even with no active group', () => {
    const shell = makeShell({ id: 'd', owner: null, cwd: 'C:\\proj\\sub' })
    const result = shellsForBoard([shell], {
      activePlannerId: null,
      livePlannerIds: new Set(),
      projectCwd: 'C:\\proj',
    })
    expect(result).toEqual([{ ...shell, attachment: 'detached' as const }])
  })

  it('drops an orphaned shell outside the project cwd', () => {
    const shell = makeShell({ id: 'e', owner: { kind: 'planner', id: 'p-gone' }, cwd: 'C:\\other' })
    const result = shellsForBoard([shell], {
      activePlannerId: null,
      livePlannerIds: new Set(),
      projectCwd: 'C:\\proj',
    })
    expect(result).toEqual([])
  })

  it('falls back to keeping an orphaned shell when the project has no cwd, like jobs do', () => {
    const shell = makeShell({ id: 'f', owner: null, cwd: 'C:\\anything' })
    const result = shellsForBoard([shell], {
      activePlannerId: null,
      livePlannerIds: new Set(),
      projectCwd: null,
    })
    expect(result).toEqual([{ ...shell, attachment: 'detached' as const }])
  })
})

describe('plannerTabActivity', () => {
  it('is never live when there is no planner id, whatever the terminal store says', () => {
    expect(plannerTabActivity(3, [], null, true)).toEqual({ count: 3, live: false })
  })

  it('reports liveness straight from the terminal, not from the jobs', () => {
    expect(plannerTabActivity(0, [], 'p1', true)).toEqual({ count: 0, live: true })
    expect(plannerTabActivity(5, [], 'p1', false)).toEqual({ count: 5, live: false })
  })

  it('adds the running shells this planner owns to its job count', () => {
    const shells = [
      makeShell({ id: 'a', owner: { kind: 'planner', id: 'p1' }, status: 'running' }),
      makeShell({ id: 'b', owner: { kind: 'planner', id: 'p1' }, status: 'exited' }),
      makeShell({ id: 'c', owner: { kind: 'planner', id: 'p2' }, status: 'running' }),
    ]
    expect(plannerTabActivity(2, shells, 'p1', true)).toEqual({ count: 3, live: true })
  })

  it('reports zero so the tab can hide its count chip when nothing is delegated or running', () => {
    expect(plannerTabActivity(0, [], 'p1', true).count).toBe(0)
  })
})

describe('shellsForBoard attachment', () => {
  const base = {
    name: 'npm',
    command: 'npm run dev',
    status: 'running' as const,
    exitCode: null,
    startedAtMs: 0,
  }
  const shell = (id: string, ownerId: string | null, cwd: string) => ({
    ...base,
    id,
    cwd,
    owner: ownerId ? ({ kind: 'planner' as const, id: ownerId }) : null,
    ptyId: `orchestrator-${id}`,
  })

  it("marks the active planner's own shells attached", () => {
    const shells = shellsForBoard([shell('shell-01', 'p1', 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => s.attachment)).toEqual(['attached'])
  })

  it("marks a shell whose planner is gone detached, when its cwd is under the project", () => {
    const shells = shellsForBoard([shell('shell-02', 'p9', 'C:\\app\\api')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => [s.id, s.attachment])).toEqual([['shell-02', 'detached']])
  })

  it('marks an ownerless shell detached', () => {
    const shells = shellsForBoard([shell('shell-03', null, 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1']),
      projectCwd: 'C:\\app',
    })
    expect(shells.map((s) => s.attachment)).toEqual(['detached'])
  })

  it("leaves another live planner's shell to that planner's tab", () => {
    const shells = shellsForBoard([shell('shell-04', 'p2', 'C:\\app')], {
      activePlannerId: 'p1',
      livePlannerIds: new Set(['p1', 'p2']),
      projectCwd: 'C:\\app',
    })
    expect(shells).toEqual([])
  })
})

describe('shellTerminalPlan', () => {
  const shell = makeShell({ ptyId: 'orchestrator-shell-01' })

  it('reuses the terminal and tab holding the shell PTY when it has a live runtime', () => {
    const terminals = [{ id: 't1', tabs: [{ id: 'tab1', ptyId: 'orchestrator-shell-01' }] }]
    const plan = shellTerminalPlan(terminals, shell, () => true)
    expect(plan).toEqual({ action: 'reuse', terminalId: 't1', tabId: 'tab1' })
  })

  it('discards a stale terminal whose PTY has no live runtime and asks for a new one', () => {
    const terminals = [{ id: 't1', tabs: [{ id: 'tab1', ptyId: 'orchestrator-shell-01' }] }]
    const plan = shellTerminalPlan(terminals, shell, () => false)
    expect(plan).toEqual({ action: 'create', staleTerminalId: 't1' })
  })

  it('asks for a new terminal with nothing stale when no tab holds this PTY', () => {
    const plan = shellTerminalPlan([], shell, () => true)
    expect(plan).toEqual({ action: 'create', staleTerminalId: null })
  })
})
