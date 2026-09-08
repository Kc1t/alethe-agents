import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MergeTree } from './MergeTree'
import type { GateResult, PendingMergeCard } from './SidebarMergePanel'

afterEach(cleanup)

const card: PendingMergeCard = {
  id: 'card-1',
  projectId: 'p1',
  projectName: 'Alethe',
  terminalId: 't1',
  worktreeAgentId: 'w1',
  branchName: 'alethe/agent-1',
  worktreePath: 'C:/tmp/w1',
  agentName: 'Opencode',
  agentType: 'opencode',
}

const failedGate: Record<string, GateResult> = {
  'card-1': { stage: 'failed', detail: 'the suite exited 1' } as GateResult,
}

function renderTree(onSelect = vi.fn()) {
  render(
    <MergeTree
      items={[card]}
      gateStatus={failedGate}
      mergePhase="idle"
      activeCardId={null}
      terminalTheme="dark"
      hasOtherProjectsPending={false}
      onSelect={onSelect}
    />,
  )
  return onSelect
}

describe('MergeTree', () => {
  it('keeps the warning affordance outside the button that selects the agent', () => {
    // The two controls sit side by side and must stay independent. Nested, the browser resolves a
    // button inside a button unpredictably; and while they were siblings, the row's own hover rule
    // still lit up the agent's name whenever the pointer was over the triangle, which read as the
    // row being selected by something that is not the row.
    renderTree()
    const select = screen.getByRole('button', { name: /Opencode/ })
    const warning = screen
      .getAllByRole('button')
      .find((button) => button !== select && button.querySelector('svg'))

    expect(warning).toBeTruthy()
    expect(select.contains(warning!)).toBe(false)
    expect(warning!.contains(select)).toBe(false)
  })

  it('does not select the agent when the warning is opened', () => {
    const onSelect = renderTree()
    const select = screen.getByRole('button', { name: /Opencode/ })
    const warning = screen
      .getAllByRole('button')
      .find((button) => button !== select && button.querySelector('svg'))!

    fireEvent.click(warning)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('selects the agent when its own row is clicked', () => {
    const onSelect = renderTree()
    fireEvent.click(screen.getByRole('button', { name: /Opencode/ }))
    expect(onSelect).toHaveBeenCalledWith(card)
  })
})
