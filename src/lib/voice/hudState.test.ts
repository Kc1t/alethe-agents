import { describe, expect, it } from 'vitest'

import { INITIAL_VOICE_CONVERSATION } from '../../stores/voiceConversationStore'
import { decodeHudAction, decodeHudState, encodeHudState, type HudViewState } from './hudState'

const sample: HudViewState = {
  state: { ...INITIAL_VOICE_CONVERSATION, transcript: 'hello' },
  targets: [],
  hint: 'hint',
  approvalChannel: 'both',
  destructiveNeedsHud: true,
  rate: 1.25,
  language: 'pt-BR',
  uiTheme: 'dark',
  visualStyle: 'normal',
}

describe('hudState', () => {
  it('round-trips a state', () => {
    expect(decodeHudState(encodeHudState(sample))).toEqual(sample)
  })

  // The HUD's picker shows the session voice talks to, resolved in the main window.
  it('round-trips the current target, and accepts a state from before it existed', () => {
    const current = {
      ptyId: 'pty-1',
      projectId: 'p',
      terminalId: 't',
      tabId: 'a',
      tabActive: true,
      label: 'Billing · Claude',
      cwd: '/w',
      sessionId: null,
    }
    const withCurrent = { ...sample, targets: [current], current }
    expect(decodeHudState(encodeHudState(withCurrent))).toEqual(withCurrent)
    expect(decodeHudState(encodeHudState({ ...sample, current: null }))?.current).toBeNull()
    expect(decodeHudState(encodeHudState(sample))?.current).toBeUndefined()
  })

  it('round-trips a pick and the unpin that follows the active pane again', () => {
    for (const action of [
      { kind: 'pin', ptyId: 'pty-2' },
      { kind: 'pin', ptyId: null },
    ] as const) {
      expect(decodeHudAction(JSON.stringify(action))).toEqual(action)
    }
    expect(decodeHudAction('{"kind":"pin"}')).toBeNull()
    expect(decodeHudAction('{"kind":"pin","ptyId":3}')).toBeNull()
  })

  it('rejects null and garbage', () => {
    expect(decodeHudState(null)).toBeNull()
    expect(decodeHudState('nope')).toBeNull()
    expect(decodeHudState('{"state":1,"rate":1}')).toBeNull()
  })

  it('rejects a state without the language and theme the HUD renders with', () => {
    const { language: _language, ...withoutLanguage } = sample
    expect(decodeHudState(JSON.stringify(withoutLanguage))).toBeNull()
    expect(decodeHudState(JSON.stringify({ ...sample, uiTheme: 3 }))).toBeNull()
    expect(decodeHudState(JSON.stringify({ ...sample, visualStyle: null }))).toBeNull()
  })

  it('accepts the known actions', () => {
    const answer = { kind: 'answer', answer: { kind: 'allow' }, requestId: 'r1' }
    expect(decodeHudAction(JSON.stringify(answer))).toEqual(answer)
    expect(
      decodeHudAction('{"kind":"answer","requestId":"r","answer":{"kind":"deny","message":"no"}}'),
    ).toEqual({ kind: 'answer', requestId: 'r', answer: { kind: 'deny', message: 'no' } })
    expect(decodeHudAction('{"kind":"pin","ptyId":null}')).toEqual({ kind: 'pin', ptyId: null })
    expect(decodeHudAction('{"kind":"stop-speaking"}')).toEqual({ kind: 'stop-speaking' })
    expect(decodeHudAction('{"kind":"dismiss"}')).toEqual({ kind: 'dismiss' })
    expect(decodeHudAction('{"kind":"rate","rate":1.5}')).toEqual({ kind: 'rate', rate: 1.5 })
  })

  it('round-trips the narration controls and their state', () => {
    for (const action of [
      { kind: 'toggle-mute' },
      { kind: 'toggle-pause' },
      { kind: 'stop-speaking' },
    ] as const) {
      expect(decodeHudAction(JSON.stringify(action))).toEqual(action)
    }
    const controls = {
      ...sample,
      state: { ...sample.state, muted: true, narrationPaused: true, narrationActive: true },
    }
    expect(decodeHudState(encodeHudState(controls))).toEqual(controls)
  })

  // A HUD still running an older bundle, or a state published before the controls existed.
  it('reads a state without the narration controls as unmuted and playing', () => {
    const {
      muted: _muted,
      narrationPaused: _paused,
      narrationActive: _active,
      ...older
    } = sample.state
    const decoded = decodeHudState(JSON.stringify({ ...sample, state: older }))
    expect(decoded?.state.muted).toBe(false)
    expect(decoded?.state.narrationPaused).toBe(false)
    expect(decoded?.state.narrationActive).toBe(false)
  })

  // The word being spoken is highlighted in the HUD; an older main window publishes none.
  it('round-trips the spoken offset and reads a missing or bad one as no highlight', () => {
    const speaking = { ...sample, state: { ...sample.state, narrationSpokenOffset: 12 } }
    expect(decodeHudState(encodeHudState(speaking))?.state.narrationSpokenOffset).toBe(12)
    const { narrationSpokenOffset: _offset, ...older } = sample.state
    expect(
      decodeHudState(JSON.stringify({ ...sample, state: older }))?.state.narrationSpokenOffset,
    ).toBeNull()
    const bad = { ...sample, state: { ...sample.state, narrationSpokenOffset: 'x' } }
    expect(decodeHudState(JSON.stringify(bad))?.state.narrationSpokenOffset).toBeNull()
  })

  // Sessions launched before voice was on are listed for a restart; older states have none.
  it('round-trips the sessions that need a restart, and the restart action', () => {
    const session = {
      ptyId: 'pty-9',
      projectId: 'p',
      terminalId: 't',
      tabId: 'a',
      tabActive: true,
      label: 'Billing · Claude',
      cwd: '/w',
      sessionId: 's9',
    }
    const withRestartable = { ...sample, restartable: [session] }
    expect(decodeHudState(encodeHudState(withRestartable))).toEqual(withRestartable)
    expect(decodeHudState(encodeHudState(sample))?.restartable).toBeUndefined()
    expect(
      decodeHudState(JSON.stringify({ ...sample, restartable: 'x' }))?.restartable,
    ).toBeUndefined()
    const restart = { kind: 'restart-session', ptyId: 'pty-9' } as const
    expect(decodeHudAction(JSON.stringify(restart))).toEqual(restart)
    expect(decodeHudAction('{"kind":"restart-session"}')).toBeNull()
    expect(decodeHudAction('{"kind":"restart-session","ptyId":""}')).toBeNull()
  })

  it('rejects unknown kinds, bad rates and malformed JSON', () => {
    expect(decodeHudAction('{"kind":"explode"}')).toBeNull()
    expect(decodeHudAction('{"kind":"rate","rate":"fast"}')).toBeNull()
    expect(decodeHudAction('{"kind":"rate","rate":9}')).toBeNull()
    expect(decodeHudAction('{"kind":"answer","answer":{"kind":"allow"}}')).toBeNull()
    expect(decodeHudAction('{"kind":"answer","requestId":"","answer":{"kind":"allow"}}')).toBeNull()
    expect(
      decodeHudAction('{"kind":"answer","requestId":"r","answer":{"kind":"unclear"}}'),
    ).toBeNull()
    expect(
      decodeHudAction('{"kind":"answer","requestId":"r","answer":{"kind":"deny","message":{}}}'),
    ).toBeNull()
    expect(decodeHudAction('{')).toBeNull()
  })
})
