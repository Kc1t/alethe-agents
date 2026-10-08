import { describe, expect, it } from 'vitest'

import { extractMediaItems, splitPromotedMedia } from './orchestratorMedia'

describe('extractMediaItems', () => {
  it('finds a local image path', () => {
    const items = extractMediaItems('Saved the chart at D:\\repo\\out\\chart.png for review.')
    expect(items).toEqual([{ kind: 'image-local', value: 'D:\\repo\\out\\chart.png' }])
  })

  it('classifies an image URL separately from a plain link', () => {
    const items = extractMediaItems(
      'See https://example.com/screenshot.png and also https://example.com/docs for context.',
    )
    expect(items).toEqual([
      { kind: 'image-url', value: 'https://example.com/screenshot.png' },
      { kind: 'link', value: 'https://example.com/docs' },
    ])
  })

  it('strips trailing punctuation from a sentence', () => {
    const items = extractMediaItems('Reference: https://example.com/page.')
    expect(items).toEqual([{ kind: 'link', value: 'https://example.com/page' }])
  })

  it('deduplicates and caps at 4 items', () => {
    const many = Array.from({ length: 6 }, (_, i) => `https://example.com/page${i}`).join(' ')
    const items = extractMediaItems(`${many} https://example.com/page0`)
    expect(items).toHaveLength(4)
  })

  it('returns nothing for plain text', () => {
    expect(extractMediaItems('Read the config files, nothing else to report.')).toEqual([])
  })
})

describe('splitPromotedMedia', () => {
  it('promotes the first non-link item and keeps the rest as remaining', () => {
    const items = extractMediaItems(
      'See https://example.com/docs, then D:\\out\\a.png and D:\\out\\b.png.',
    )
    const { promoted, remaining } = splitPromotedMedia(items)
    expect(promoted).toEqual({ kind: 'image-local', value: 'D:\\out\\a.png' })
    expect(remaining).toEqual([
      { kind: 'image-local', value: 'D:\\out\\b.png' },
      { kind: 'link', value: 'https://example.com/docs' },
    ])
  })

  it('promotes nothing when every item is a link', () => {
    const items = extractMediaItems('See https://example.com/a and https://example.com/b.')
    const { promoted, remaining } = splitPromotedMedia(items)
    expect(promoted).toBeNull()
    expect(remaining).toEqual(items)
  })

  it('promotes the only item and leaves nothing remaining', () => {
    const items = extractMediaItems('Saved D:\\out\\chart.png for review.')
    const { promoted, remaining } = splitPromotedMedia(items)
    expect(promoted).toEqual({ kind: 'image-local', value: 'D:\\out\\chart.png' })
    expect(remaining).toEqual([])
  })

  it('returns nothing for an empty list', () => {
    expect(splitPromotedMedia([])).toEqual({ promoted: null, remaining: [] })
  })
})
