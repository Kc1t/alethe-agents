import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CapabilityList } from './pluginCapabilities'
afterEach(cleanup)

describe('voice plugin trust labels', () => {
  it('plainly discloses activity observation, permission approval, restarts, and voice hooks', () => {
    render(
      <CapabilityList
        capabilities={['agent.observe', 'agent.approve', 'terminal.restart', 'voice.converse']}
      />,
    )
    expect(
      screen.getByText('See agent activity, tool calls, and conversation transcripts'),
    ).toBeInTheDocument()
    expect(screen.getByText('Approve or deny agent actions on your behalf')).toBeInTheDocument()
    expect(
      screen.getByText('Restart agent sessions and resume their conversations'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Enable voice conversation hooks and select conversation targets'),
    ).toBeInTheDocument()
  })
})
