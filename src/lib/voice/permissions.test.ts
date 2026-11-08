import { describe, expect, it } from 'vitest'

import { answerAllowed } from './permissions'

describe('answerAllowed', () => {
  const both = { channel: 'both' as const, destructiveNeedsHud: true }

  it('refuses a spoken yes to a destructive request by default', () => {
    expect(answerAllowed({ kind: 'allow' }, true, both, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, true, both, 'hud')).toBe(true)
  })

  it('accepts a spoken no to a destructive request', () => {
    expect(answerAllowed({ kind: 'deny' }, true, both, 'voice')).toBe(true)
  })

  it('accepts a spoken yes to a destructive request when the person turned the guard off', () => {
    expect(
      answerAllowed(
        { kind: 'allow' },
        true,
        { channel: 'both', destructiveNeedsHud: false },
        'voice',
      ),
    ).toBe(true)
  })

  it('follows the approval channel', () => {
    const hudOnly = { channel: 'hud' as const, destructiveNeedsHud: true }
    const voiceOnly = { channel: 'voice' as const, destructiveNeedsHud: true }
    expect(answerAllowed({ kind: 'allow' }, false, hudOnly, 'voice')).toBe(false)
    expect(answerAllowed({ kind: 'allow' }, false, voiceOnly, 'hud')).toBe(false)
    // The guard needs a click, so the panel answers a destructive request even in voice-only mode.
    expect(answerAllowed({ kind: 'allow' }, true, voiceOnly, 'hud')).toBe(true)
  })

  it('always lets the person hand the question back to the terminal', () => {
    expect(answerAllowed({ kind: 'defer' }, true, both, 'hud')).toBe(true)
    expect(
      answerAllowed(
        { kind: 'defer' },
        false,
        { channel: 'voice', destructiveNeedsHud: true },
        'hud',
      ),
    ).toBe(true)
  })
})
