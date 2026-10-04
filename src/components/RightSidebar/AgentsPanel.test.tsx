import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recordClaudeLaunch } from '../../lib/claudeMcpConfigs'
import {
  listenOrchestratorJobs,
  orchestratorAnswer,
  orchestratorCancel,
  orchestratorJobs,
  type OrchestratorJob,
  type OrchestratorSnapshot,
} from '../../lib/tauri/orchestrator'
import { EMPTY_PROJECTS_FILE } from '../../lib/types'
import { useAgentCanvasStore } from '../../stores/agentCanvasStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { AgentsPanel } from './AgentsPanel'

vi.mock('../../lib/tauri/orchestrator', () => ({
  orchestratorJobs: vi.fn(),
  listenOrchestratorJobs: vi.fn(async () => () => {}),
  orchestratorCancel: vi.fn(async () => ({})),
  orchestratorAnswer: vi.fn(async () => ({ answered: 'ok', decision: 'accept' })),
}))

function snapshot(jobs: OrchestratorJob[]): OrchestratorSnapshot {
  return {
    jobs,
    planners: [],
    running: jobs.filter((j) => j.status === 'running').length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    concurrencyLimit: 4,
    roles: [],
  }
}

function job(partial: Partial<OrchestratorJob> = {}): OrchestratorJob {
  return {
    id: 'job-1',
    plannerId: null,
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    spec: 'Refactor the parser',
    cwd: 'C:\\repo',
    status: 'running',
    threadId: null,
    outcome: null,
    seconds: 65,
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(orchestratorJobs).mockResolvedValue(snapshot([]))
  vi.mocked(listenOrchestratorJobs).mockResolvedValue(() => {})
  useProjectsStore.setState({ ...structuredClone(EMPTY_PROJECTS_FILE), hydrated: true })
  useUiStore.setState({
    focusedTerminalId: null,
    rightSidebarMode: 'agents',
    agentsSidebarPrev: null,
  })
  useAgentCanvasStore.setState({ nodes: [] })
})

afterEach(() => {
  recordClaudeLaunch('pty-planner', false)
})

describe('AgentsPanel', () => {
  it('explains the panel when nothing is delegated yet', async () => {
    render(<AgentsPanel />)

    expect(await screen.findByText('No agents in use')).toBeTruthy()
  })

  it('renders a compact card per worker with status, model, elapsed and cost', async () => {
    vi.mocked(orchestratorJobs).mockResolvedValue(
      snapshot([
        job({ model: 'gpt-6.1-sol', costUsd: 1 }),
        job({
          id: 'job-2',
          spec: 'Write the tests',
          status: 'blocked',
          seconds: 12,
          pendingApproval: {
            rpcId: 'rpc-1',
            kind: 'command',
            command: 'npm test',
            cwd: 'C:\\repo',
            reason: null,
            askedAtMs: Date.now(),
          },
        }),
      ]),
    )
    render(<AgentsPanel />)

    expect(await screen.findByText('Refactor the parser')).toBeTruthy()
    expect(screen.getByText('codex · gpt-6.1-sol')).toBeTruthy()
    expect(screen.getByText('1m 05s')).toBeTruthy()
    expect(screen.getByText('$1.00')).toBeTruthy()
    expect(screen.getByText('Write the tests')).toBeTruthy()
  })

  it('answers a blocked worker and cancels a live one', async () => {
    vi.mocked(orchestratorJobs).mockResolvedValue(
      snapshot([
        job(),
        job({
          id: 'job-2',
          spec: 'Write the tests',
          status: 'blocked',
          pendingApproval: {
            rpcId: 'rpc-1',
            kind: 'command',
            command: 'npm test',
            cwd: null,
            reason: null,
            askedAtMs: Date.now(),
          },
        }),
      ]),
    )
    render(<AgentsPanel />)
    await screen.findByText('Write the tests')

    fireEvent.click(screen.getByRole('button', { name: 'Approve once' }))
    await act(async () => {})
    expect(orchestratorAnswer).toHaveBeenCalledWith('job-2', 'accept')

    const runningCard = screen.getByText('Refactor the parser').closest('article')
    expect(runningCard).not.toBeNull()
    fireEvent.click(within(runningCard!).getByRole('button', { name: 'Stop' }))
    await act(async () => {})
    expect(orchestratorCancel).toHaveBeenCalledWith('job-1')
  })

  it('scopes the list to the focused planner when one is in focus mode', async () => {
    const store = useProjectsStore.getState()
    const project = store.createProject({ name: 'App' })
    const terminal = store.createTerminal(project.id, {
      name: 'Planner',
      cwd: 'C:\\repo',
      firstTab: { type: 'claude', cwd: 'C:\\repo' },
    })
    useProjectsStore.setState((state) => ({
      projects: state.projects.map((p) => ({
        ...p,
        terminals: p.terminals.map((entry) =>
          entry.id === terminal.id
            ? { ...entry, tabs: entry.tabs.map((tab) => ({ ...tab, ptyId: 'pty-planner' })) }
            : entry,
        ),
      })),
    }))
    recordClaudeLaunch('pty-planner', true)
    useUiStore.setState({ focusedTerminalId: terminal.id })
    vi.mocked(orchestratorJobs).mockResolvedValue(
      snapshot([
        job({ plannerId: 'pty-planner', spec: 'Mine' }),
        job({ id: 'job-2', plannerId: 'pty-other', spec: 'Someone else' }),
      ]),
    )

    render(<AgentsPanel />)

    expect(await screen.findByText('Mine')).toBeTruthy()
    expect(screen.queryByText('Someone else')).toBeNull()
    expect(screen.getByText('Focused planner')).toBeTruthy()
  })
})
