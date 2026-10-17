import { describe, expect, it } from 'vitest'

import { codePointLength, estimatedSpokenOffset, spokenParts, wordStartIn } from './spokenWords'

describe('spokenParts', () => {
  it('splits the text around the word containing the offset', () => {
    expect(spokenParts('Run the tests now.', 9)).toEqual({
      spoken: 'Run the ',
      current: 'tests',
      upcoming: ' now.',
    })
    // The first character of a word already makes it the current one.
    expect(spokenParts('Run the tests now.', 8)?.current).toBe('tests')
    expect(spokenParts('Run the tests now.', 0)).toEqual({
      spoken: '',
      current: 'Run',
      upcoming: ' the tests now.',
    })
  })

  it('keeps punctuation with its word', () => {
    expect(spokenParts('Done, then "quoted".', 2)?.current).toBe('Done,')
    expect(spokenParts('Done, then "quoted".', 13)?.current).toBe('"quoted".')
  })

  // Between words, the word about to be said is the current one.
  it('takes the next word when the offset falls on spaces, however many', () => {
    expect(spokenParts('one   two', 4)).toEqual({ spoken: 'one   ', current: 'two', upcoming: '' })
    expect(spokenParts('one\n\ttwo', 3)?.current).toBe('two')
  })

  // Offsets are code points, as Rust counts them: an emoji or a CJK character is one.
  it('counts code points, not UTF-16 units', () => {
    expect(codePointLength('é😀語')).toBe(3)
    expect(spokenParts('😀 olá 語言', 2)).toEqual({
      spoken: '😀 ',
      current: 'olá',
      upcoming: ' 語言',
    })
    expect(spokenParts('😀 olá 語言', 6)?.current).toBe('語言')
  })

  it('marks everything spoken at or past the end, and nothing without an offset', () => {
    expect(spokenParts('All done.', 9)).toEqual({ spoken: 'All done.', current: '', upcoming: '' })
    expect(spokenParts('All done.', 99)?.spoken).toBe('All done.')
    expect(spokenParts('All done.', null)).toBeNull()
    expect(spokenParts('', 0)).toBeNull()
    expect(spokenParts('All done.', -3)?.current).toBe('All')
  })
})

describe('estimatedSpokenOffset', () => {
  // The same 75 ms a character the narrator's estimate uses, faster at a higher rate.
  it('advances with the speaking time and the rate, clamped to the text', () => {
    expect(estimatedSpokenOffset(0, 1, 40)).toBe(0)
    expect(estimatedSpokenOffset(750, 1, 40)).toBe(10)
    expect(estimatedSpokenOffset(750, 2, 40)).toBe(20)
    expect(estimatedSpokenOffset(60_000, 1, 40)).toBe(40)
    expect(estimatedSpokenOffset(-5, 1, 40)).toBe(0)
  })
})

describe('wordStartIn', () => {
  it('gives the start of the word the offset falls in, or of the next one', () => {
    const chars = Array.from('😀 olá  語言.')
    expect(wordStartIn(chars, 0)).toBe(0)
    expect(wordStartIn(chars, 3)).toBe(2)
    expect(wordStartIn(chars, 5)).toBe(7)
    expect(wordStartIn(chars, 9)).toBe(7)
    expect(wordStartIn(chars, 10)).toBe(10)
    expect(wordStartIn(chars, 99)).toBe(10)
  })
})
