import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../XTermView', () => ({ XTermView: () => <div data-testid="xterm" /> }))
vi.mock('../MarkdownPane/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))
// Real Tauri glue is unavailable in jsdom; the media strip calls this to build thumbnail `src`s.
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }))

import type { TFunction } from '../../lib/i18n'
import type { OrchestratorJob, OrchestratorShell } from '../../lib/tauri/orchestrator'
import { OrchestratorInspector } from './OrchestratorInspector'

afterEach(cleanup)

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${Object.values(vars).join(' ')}` : key) as unknown as TFunction

const job = (patch: Partial<OrchestratorJob> = {}): OrchestratorJob =>
  ({
    id: 'job-01',
    plannerId: 'p1',
    agent: 'codex',
    runId: 'run-1',
    runLabel: null,
    rules: null,
    spec: 'spec',
    cwd: 'C:\\app',
    status: 'done',
    threadId: null,
    outcome: null,
    seconds: 4,
    plan: ['step one'],
    tokens: null,
    quota: null,
    routing: null,
    worktree: null,
    pendingApproval: null,
    hasDiff: true,
    summary: 'the report body',
    ...patch,
  }) as OrchestratorJob

const shell: OrchestratorShell = {
  id: 'shell-01',
  name: 'npm',
  command: 'npm run dev',
  cwd: 'C:\\app',
  owner: { kind: 'planner', id: 'p1' },
  status: 'running',
  exitCode: null,
  startedAtMs: 0,
  ptyId: 'orchestrator-shell-01',
}

const base = {
  projectId: 'proj',
  theme: 'dark' as const,
  terminalTheme: 'dark' as const,
  diffText: undefined,
  diffLoading: false,
  shortcuts: [{ id: 'review', name: 'Review', text: 'review {jobId}', rule: 'finished' as const }],
  plannerAlive: true,
  shellBusy: false,
  canStopJob: false,
  onClose: vi.fn(),
  onLoadDiff: vi.fn(),
  onStopJob: vi.fn(),
  onShortcut: vi.fn(),
  onShellControl: vi.fn(),
  t,
}

describe('OrchestratorInspector', () => {
  it('shows a worker\u2019s plan and report, and its diff tab on demand', () => {
    const onLoadDiff = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onLoadDiff={onLoadDiff}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    expect(screen.getByText('step one')).toBeTruthy()
    expect(screen.getByText('the report body')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'orchestrator.diffTab' }))
    expect(onLoadDiff).toHaveBeenCalledWith('job-01')
  })

  it('hides the diff tab when the worker changed nothing', () => {
    render(
      <OrchestratorInspector {...base} target={{ kind: 'worker', job: job({ hasDiff: false }) }} />,
    )
    expect(screen.queryByRole('tab', { name: 'orchestrator.diffTab' })).toBeNull()
  })

  it('offers no stop and no diff for a native subagent', () => {
    render(
      <OrchestratorInspector
        {...base}
        canStopJob={false}
        target={{ kind: 'worker', job: job({ native: true, hasDiff: false }) }}
      />,
    )
    expect(screen.queryByRole('button', { name: 'orchestrator.stopWorker' })).toBeNull()
  })

  it('sends the shortcut that was clicked', () => {
    const onShortcut = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onShortcut={onShortcut}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onShortcut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-01' }),
      expect.objectContaining({ id: 'review' }),
    )
  })

  it('says why there are no shortcuts when the planner is gone', () => {
    render(
      <OrchestratorInspector
        {...base}
        plannerAlive={false}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    expect(screen.getByText('orchestrator.noPlannerForShortcuts')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
  })

  it('offers the shortcut and no explanation when the planner is alive', () => {
    render(
      <OrchestratorInspector
        {...base}
        plannerAlive={true}
        target={{ kind: 'worker', job: job() }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy()
    expect(screen.queryByText('orchestrator.noPlannerForShortcuts')).toBeNull()
  })

  it('renders a shell as a live terminal with its controls', () => {
    const onShellControl = vi.fn()
    render(
      <OrchestratorInspector
        {...base}
        onShellControl={onShellControl}
        target={{ kind: 'shell', shell }}
      />,
    )
    expect(screen.getByTestId('xterm')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'orchestrator.shell.stop' }))
    expect(onShellControl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shell-01' }),
      'stop',
    )
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <OrchestratorInspector {...base} onClose={onClose} target={{ kind: 'worker', job: job() }} />,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close the panel on Escape while the image lightbox is open', () => {
    const onClose = vi.fn()
    // Two images: the first is promoted away by `remainingMedia`, so only the second reaches the
    // strip and can be clicked open.
    const mediaJob = job({ summary: 'See C:\\shots\\one.png and C:\\shots\\two.png' })
    render(
      <OrchestratorInspector
        {...base}
        onClose={onClose}
        target={{ kind: 'worker', job: mediaJob }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'two.png' }))
    expect(screen.getByText('C:\\shots\\two.png')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const onClose = vi.fn()
    render(
      <OrchestratorInspector {...base} onClose={onClose} target={{ kind: 'worker', job: job() }} />,
    )

    const panel = screen.getByRole('dialog')
    fireEvent.click(panel)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(panel.parentElement as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
