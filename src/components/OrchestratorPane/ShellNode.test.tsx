import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { orchestratorShellOutput } = vi.hoisted(() => ({
  orchestratorShellOutput: vi.fn(() =>
    Promise.resolve({ shellId: 'shell-01', status: 'running', exitCode: null, output: 'listening on :3000' }),
  ),
}))
vi.mock('../../lib/tauri/orchestrator', () => ({ orchestratorShellOutput }))

import type { TFunction } from '../../lib/i18n'
import type { GraphNode } from '../../lib/orchestratorGraph'
import type { BoardShell } from '../../lib/orchestratorShells'
import { ShellNode } from './ShellNode'

afterEach(cleanup)

const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key} ${Object.values(vars).join(' ')}` : key) as unknown as TFunction

const node: GraphNode = {
  id: 'shell-01',
  kind: 'shell',
  depth: 1,
  index: 0,
  x: 0,
  y: 0,
  width: 252,
  height: 80,
}

function shell(status: BoardShell['status'] = 'running', exitCode: number | null = null): BoardShell {
  return {
    id: 'shell-01',
    name: 'npm',
    command: 'npm run dev',
    cwd: 'C:\\app',
    owner: { kind: 'planner', id: 'p1' },
    status,
    exitCode,
    startedAtMs: 0,
    ptyId: 'orchestrator-shell-01',
    attachment: 'attached',
  }
}

const props = {
  shell: shell(),
  node,
  selected: false,
  busy: false,
  onOpen: vi.fn(),
  onControl: vi.fn(),
  bind: vi.fn(),
  t,
}

describe('ShellNode', () => {
  it('shows the command, the last output line and the hover controls', async () => {
    render(<ShellNode {...props} />)
    await waitFor(() => expect(screen.getByText('listening on :3000')).toBeTruthy())
    expect(screen.getByText('npm run dev')).toBeTruthy()
    for (const label of [
      'orchestrator.shell.stop',
      'orchestrator.shell.restart',
      'orchestrator.shell.openTerminal',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: 'orchestrator.shell.remove' })).toBeNull()
  })

  it('offers run again and remove once it has exited, with its code', () => {
    render(<ShellNode {...props} shell={shell('exited', 1)} />)
    expect(screen.getByText('orchestrator.shell.exited 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'orchestrator.shell.play' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'orchestrator.shell.remove' })).toBeTruthy()
  })

  it('opens the inspector when the card is clicked', () => {
    const onOpen = vi.fn()
    render(<ShellNode {...props} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /npm run dev/ }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'shell-01' }))
  })

  it('passes the control that was clicked', () => {
    const onControl = vi.fn()
    render(<ShellNode {...props} onControl={onControl} />)
    fireEvent.click(screen.getByRole('button', { name: 'orchestrator.shell.stop' }))
    expect(onControl).toHaveBeenCalledWith(expect.objectContaining({ id: 'shell-01' }), 'stop')
  })
})
