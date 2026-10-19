import { describe, expect, it } from 'vitest'

import { displayPhase, nextCapture, nextTurn } from './stateMachine'

describe('capture', () => {
  it('runs press → listening → transcribing → sending → idle', () => {
    let state = nextCapture('idle', 'press')
    expect(state).toBe('listening')
    state = nextCapture(state, 'captured')
    expect(state).toBe('transcribing')
    state = nextCapture(state, 'transcribed')
    expect(state).toBe('sending')
    expect(nextCapture(state, 'done')).toBe('idle')
  })

  it('goes back to idle on silence or failure, from anywhere', () => {
    expect(nextCapture('transcribing', 'nothing')).toBe('idle')
    for (const state of ['listening', 'transcribing', 'sending'] as const) {
      expect(nextCapture(state, 'failed')).toBe('idle')
    }
  })

  it('ignores events that do not apply', () => {
    expect(nextCapture('idle', 'captured')).toBe('idle')
    expect(nextCapture('listening', 'press')).toBe('listening')
  })
})

describe('turn', () => {
  it('runs sent → working → awaiting-permission → working → idle', () => {
    let state = nextTurn('idle', 'sent')
    expect(state).toBe('working')
    state = nextTurn(state, 'permission')
    expect(state).toBe('awaiting-permission')
    state = nextTurn(state, 'answered')
    expect(state).toBe('working')
    expect(nextTurn(state, 'stopped')).toBe('idle')
  })

  it('keeps working when more is said mid-task, and resets when the target is gone', () => {
    expect(nextTurn('working', 'sent')).toBe('working')
    expect(nextTurn('awaiting-permission', 'reset')).toBe('idle')
    expect(nextTurn('idle', 'permission')).toBe('idle')
  })
})

describe('displayPhase', () => {
  it('shows capture over the turn, so talking mid-task reads as listening', () => {
    expect(displayPhase('listening', 'working')).toBe('listening')
    expect(displayPhase('idle', 'awaiting-permission')).toBe('awaiting-permission')
    expect(displayPhase('idle', 'idle')).toBe('idle')
  })
})
