import { describe, expect, it } from 'vitest'

import { createSpeechEndpoint, vadSpeechEnded } from './endpoint'

const TICK = 60

function run(levels: number[]): number | null {
  const endpoint = createSpeechEndpoint()
  for (let index = 0; index < levels.length; index += 1) {
    if (endpoint.push(levels[index], index * TICK)) return index * TICK
  }
  return null
}

function noisy(count: number, base: number, spike: number): number[] {
  return Array.from({ length: count }, (_, index) => (index % 7 === 0 ? spike : base))
}

function speech(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index % 6 === 0 ? 0.03 : 0.25))
}

function loudThenSoft(): number[] {
  return [...speech(8).map((value) => value * 3), ...speech(30).map((value) => value * 0.3)]
}

describe('vad speech end', () => {
  it('waits for real speech followed by a pause', () => {
    expect(vadSpeechEnded({ heardMs: 0, silenceMs: 5000 })).toBe(false)
    expect(vadSpeechEnded({ heardMs: 1200, silenceMs: 400 })).toBe(false)
    expect(vadSpeechEnded({ heardMs: 1200, silenceMs: 950 })).toBe(true)
  })
})

describe('speech endpoint', () => {
  it('does not end when a loud word is followed by softer speech', () => {
    expect(run([...noisy(10, 0.002, 0.004), ...loudThenSoft()])).toBeNull()
  })

  it('ends after a pause in a quiet room', () => {
    const levels = [...noisy(10, 0.002, 0.004), ...speech(30), ...noisy(40, 0.002, 0.004)]
    const endedAt = run(levels)
    expect(endedAt).not.toBeNull()
    expect(endedAt! - 40 * TICK).toBeLessThan(2000)
  })

  it('ends after a pause even with background noise above the old fixed threshold', () => {
    const levels = [...noisy(10, 0.02, 0.05), ...speech(30), ...noisy(40, 0.02, 0.05)]
    const endedAt = run(levels)
    expect(endedAt).not.toBeNull()
    expect(endedAt! - 40 * TICK).toBeLessThan(2000)
  })

  it('does not end during short gaps between words', () => {
    const levels = [...speech(20), ...noisy(8, 0.01, 0.02), ...speech(20)]
    expect(run(levels)).toBeNull()
  })

  it('does not end before anyone speaks', () => {
    expect(run(noisy(60, 0.02, 0.05))).toBeNull()
  })
})
