import { describe, expect, it } from 'vitest'

import { displayPhase } from './stateMachine'

describe('displayPhase', () => {
  it('shows capture over the turn, so talking mid-task reads as listening', () => {
    expect(displayPhase('listening', 'working')).toBe('listening')
    expect(displayPhase('idle', 'awaiting-permission')).toBe('awaiting-permission')
    expect(displayPhase('idle', 'idle')).toBe('idle')
  })
})
