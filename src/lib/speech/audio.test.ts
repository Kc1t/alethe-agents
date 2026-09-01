import { describe, expect, it } from 'vitest'

import { concatFloat32, resampleLinear } from './audio'

describe('speech audio helpers', () => {
  it('resamples 48 kHz down to 16 kHz', () => {
    const input = new Float32Array(4800)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 20)
    const output = resampleLinear(input, 48_000, 16_000)
    expect(output.length).toBe(1600)
  })

  it('concatenates pcm chunks', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })
})
