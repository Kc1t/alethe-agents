import { describe, expect, it } from 'vitest'

import {
  editDistance,
  matchesTrigger,
  normalizeWord,
  routeTranscript,
  type RoutingOptions,
} from './routing'

const options = (overrides: Partial<RoutingOptions> = {}): RoutingOptions => ({
  jevTrigger: 'alethe',
  interruptWords: ['stop', 'espera', 'cancela'],
  midTaskDefault: 'queue',
  busy: false,
  jevModifier: false,
  ...overrides,
})

describe('normalizeWord', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalizeWord('Não,')).toBe('nao')
    expect(normalizeWord('ALETÍ!')).toBe('aleti')
  })
})

describe('editDistance', () => {
  it('counts single edits', () => {
    expect(editDistance('alethe', 'alethe')).toBe(0)
    expect(editDistance('alethe', 'alethea')).toBe(1)
    expect(editDistance('alethe', 'athlete')).toBeGreaterThan(1)
  })
})

describe('matchesTrigger', () => {
  it('accepts the ways STT spells the trigger', () => {
    for (const spelled of ['alethe', 'alethea', 'aleti', 'alete', 'aletheia']) {
      expect(matchesTrigger(spelled, 'alethe')).toBe(true)
    }
    expect(matchesTrigger('athlete', 'alethe')).toBe(false)
    expect(matchesTrigger('', 'alethe')).toBe(false)
  })
})

describe('routeTranscript', () => {
  it('sends plain speech to Claude without interrupting', () => {
    expect(routeTranscript('fix the failing test', options())).toEqual({
      kind: 'send',
      text: 'fix the failing test',
      interrupt: false,
    })
  })

  it('ignores silence', () => {
    expect(routeTranscript('   ', options())).toEqual({ kind: 'empty' })
  })

  it('routes the trigger word to Jev, however STT spelled it', () => {
    expect(routeTranscript('Alethe, open Claude in billing', options())).toEqual({
      kind: 'jev',
      text: 'open Claude in billing',
    })
    expect(routeTranscript('Alethea open a terminal', options())).toEqual({
      kind: 'jev',
      text: 'open a terminal',
    })
    expect(routeTranscript('A lethe, focus the API pane', options())).toEqual({
      kind: 'jev',
      text: 'focus the API pane',
    })
  })

  it('routes everything to Jev while the modifier is held', () => {
    expect(routeTranscript('open the docs', options({ jevModifier: true }))).toEqual({
      kind: 'jev',
      text: 'open the docs',
    })
  })

  it('interrupts on a leading keyword followed by punctuation or the end', () => {
    expect(routeTranscript('Stop, use pnpm instead.', options())).toEqual({
      kind: 'send',
      text: 'use pnpm instead.',
      interrupt: true,
    })
    expect(routeTranscript('Espera.', options())).toEqual({
      kind: 'send',
      text: '',
      interrupt: true,
    })
    expect(routeTranscript('stop', options())).toEqual({ kind: 'send', text: '', interrupt: true })
  })

  it('does not interrupt when the keyword is part of a sentence', () => {
    expect(routeTranscript('stop words are filtered out', options())).toEqual({
      kind: 'send',
      text: 'stop words are filtered out',
      interrupt: false,
    })
  })

  it('does not treat "para" as an interrupt by default', () => {
    expect(routeTranscript('Para isso, use pnpm', options())).toEqual({
      kind: 'send',
      text: 'Para isso, use pnpm',
      interrupt: false,
    })
  })

  it('interrupts mid-task only when that is the default', () => {
    expect(routeTranscript('add a test', options({ busy: true }))).toMatchObject({
      interrupt: false,
    })
    expect(
      routeTranscript('add a test', options({ busy: true, midTaskDefault: 'interrupt' })),
    ).toMatchObject({ interrupt: true })
    expect(
      routeTranscript('add a test', options({ busy: false, midTaskDefault: 'interrupt' })),
    ).toMatchObject({ interrupt: false })
  })
})
