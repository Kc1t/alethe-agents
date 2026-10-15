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
