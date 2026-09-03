import { describe, expect, it } from 'vitest'

import { extractMediaItems } from './orchestratorMedia'

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
