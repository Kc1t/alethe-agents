import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => {
  const job = {
    id: 'job-1',
    plannerId: 'planner-pty',
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    rules: null,
    spec: 'Build a thing',
    cwd: 'C:\\repo',
    status: 'running',
    threadId: null,
    outcome: null,
    seconds: 3,
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
  }
  return {
    snapshot: {
      jobs: [job],
      planners: [{ id: 'planner-pty', label: 'Planner', agent: 'codex' }],
      running: 1,
      queued: 0,
      concurrencyLimit: 4,
      shells: [],
      roles: [],
    },
    jobs: vi.fn(),
    push: undefined as ((snapshot: unknown) => void) | undefined,
    listen: vi.fn((handler: (snapshot: unknown) => void) => {
      fixtures.push = handler
      return Promise.resolve(() => {})
    }),
  }
})

vi.mock('../../hooks/useOrchestratorQuotaWarnings', () => ({
  useOrchestratorQuotaWarnings: () => [],
}))
vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}))
vi.mock('../../lib/tauri', () => ({
  listenOrchestratorJobs: fixtures.listen,
  orchestratorJobs: fixtures.jobs,
  orchestratorAnswer: vi.fn(),
  orchestratorCancelJob: vi.fn(),
  orchestratorJobDiff: vi.fn(),
  orchestratorShellRemove: vi.fn(),
  orchestratorShellRestart: vi.fn(),
  orchestratorShellStop: vi.fn(),
  orchestratorRestart: vi.fn(),
  openOrchestrationWindow: vi.fn(),
}))
vi.mock('../../lib/agentCanvasMirror', () => ({ startAgentCanvasMirror: vi.fn() }))
vi.mock('../../stores/agentCanvasStore', () => ({
  useAgentCanvasStore: (select: (state: unknown) => unknown) => select({ nodes: [] }),
}))
vi.mock('../../stores/nodeCostStore', () => ({
  useNodeCostStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ byNodeId: {} }),
    {
      getState: () => ({ refresh: vi.fn() }),
    },
  ),
}))
vi.mock('../../stores/projectsStore', () => {
  const project = {
    id: 'project-1',
    defaultCwd: 'C:\\repo',
    paneGroups: [],
    terminals: [{ id: 'planner-terminal', tabs: [{ id: 'tab-1', ptyId: 'planner-pty' }] }],
  }
  const state = {
    preferences: { uiTheme: 'dark', terminalTheme: 'dark', orchestratorShortcuts: [] },
    projects: [project],
    closePane: vi.fn(),
    openTerminalWorkspace: vi.fn(),
    createTerminal: vi.fn(),
    deleteTerminal: vi.fn(),
    setActiveTab: vi.fn(),
  }
  return { useProjectsStore: (select: (state: unknown) => unknown) => select(state) }
})
vi.mock('../../stores/terminalsStore', () => ({
  useTerminalsStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ byPtyId: { 'planner-pty': { alive: true } } }),
    {
      getState: () => ({ byPtyId: { 'planner-pty': { alive: true } } }),
    },
  ),
}))
vi.mock('../../stores/uiStore', () => {
  const state = {
    pushToast: vi.fn(),
    openModal_: vi.fn(),
    setActiveTerminal: vi.fn(),
    setActiveView: vi.fn(),
    requestPaneFocus: vi.fn(),
    setInspectorPty: vi.fn(),
  }
  return { useUiStore: (select: (state: unknown) => unknown) => select(state) }
})
vi.mock('../modals/Modal', () => ({ Modal: () => null }))
vi.mock('./OrchestratorInspector', () => ({ OrchestratorInspector: () => null }))
vi.mock('./ShellNode', () => ({ ShellNode: () => null }))
vi.mock('./WorkerContextMenu', () => ({ WorkerContextMenu: () => null }))
vi.mock('../XTermView/terminalWrite', () => ({ writePtyChunked: vi.fn() }))

import { OrchestratorPane } from './index'

let resizeCallback: ResizeObserverCallback | undefined

beforeEach(() => {
  fixtures.jobs.mockResolvedValue(fixtures.snapshot)
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  HTMLElement.prototype.setPointerCapture ??= vi.fn()
  HTMLElement.prototype.hasPointerCapture ??= vi.fn(() => false)
  HTMLElement.prototype.releasePointerCapture ??= vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resizeCallback = undefined
  fixtures.snapshot.jobs[0].routing = null
})

describe('OrchestratorPane view fitting', () => {
  it('fits initially and preserves the world transform after a pan and resize notification', async () => {
    render(<OrchestratorPane projectId="project-1" terminal={{ id: 'board-terminal' } as never} />)

    const board = await screen
      .findByText('Build a thing')
      .then((element) => element.closest('[class*="board"]') as HTMLElement)
    const world = board.querySelector('[class*="world"]') as HTMLElement
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'))

    fireEvent.pointerDown(board, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(board, { pointerId: 1, clientX: 145, clientY: 130 })
    fireEvent.pointerUp(board, { pointerId: 1 })
    const pannedTransform = world.style.transform
    expect(pannedTransform).not.toBe('')

    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver)
    })
    expect(world.style.transform).toBe(pannedTransform)
  })

  it('keeps a pan made after re-selecting the active planner when a live update grows the board', async () => {
    render(<OrchestratorPane projectId="project-1" terminal={{ id: 'board-terminal' } as never} />)

    const board = await screen
      .findByText('Build a thing')
      .then((element) => element.closest('[class*="board"]') as HTMLElement)
    const world = board.querySelector('[class*="world"]') as HTMLElement
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'))

    fireEvent.click(screen.getByRole('tab', { selected: true }))
    fireEvent.pointerDown(board, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(board, { pointerId: 1, clientX: 145, clientY: 130 })
    fireEvent.pointerUp(board, { pointerId: 1 })
    const pannedTransform = world.style.transform

    const [first] = fixtures.snapshot.jobs
    await act(async () => {
      fixtures.push?.({
        ...fixtures.snapshot,
        jobs: [first, { ...first, id: 'job-2', spec: 'Build another thing' }],
        running: 2,
      })
    })
    await screen.findByText('Build another thing')
    expect(world.style.transform).toBe(pannedTransform)
  })
})

describe('OrchestratorPane routing notes', () => {
  it('renders a routing rule label with its role', async () => {
    fixtures.snapshot.jobs[0].routing = { verdict: 'rule', rule: 'frontend', role: 'worker' }

    render(<OrchestratorPane projectId="project-1" terminal={{ id: 'board-terminal' } as never} />)

    const note = await screen.findByText('orchestrator.routingRule worker')
    expect(note.textContent).not.toContain('undefined')
    expect(note).toHaveAttribute('data-verdict', 'rule')
  })
})
