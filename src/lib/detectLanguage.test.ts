import { describe, expect, it } from 'vitest'

import { detectLanguage } from './detectLanguage'

describe('detectLanguage', () => {
  it('recognizes Portuguese commit prose', () => {
    expect(
      detectLanguage('corrige o scroll que não funcionava quando a lista estava filtrada'),
    ).toBe('pt-BR')
  })

  it('recognizes English commit prose', () => {
    expect(
      detectLanguage('fix the scroll that would not work when the list was being filtered'),
    ).toBe('en')
  })

  it('returns null for short keyword-only subjects that carry no grammar', () => {
    // Guessing here is what would mislabel messages and offer to translate text that needs none.
    expect(detectLanguage('fix: typo')).toBeNull()
    expect(detectLanguage('chore: bump deps')).toBeNull()
    expect(detectLanguage('')).toBeNull()
  })

  it('is not fooled by English jargon inside a Portuguese sentence', () => {
    // Commit messages are full of English content words even when the sentence is Portuguese, so
    // only function words are counted.
    expect(detectLanguage('refactor do commit graph para que ele não quebre o layout')).toBe(
      'pt-BR',
    )
  })

  it('does not let accents alone outvote clear English grammar', () => {
    expect(
      detectLanguage('this is the change that fixes the panel when it is resized by the user'),
    ).toBe('en')
  })
})
