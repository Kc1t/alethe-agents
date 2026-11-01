import { describe, expect, it } from 'vitest'

import { mergeFields, mergeKeyed, sameValue, stableStringify } from './merge'

describe('stableStringify', () => {
  it('ignores key order and undefined fields', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, 2] }, b: 1 }),
    )
    expect(sameValue([1, 2], [2, 1])).toBe(false)
  })
})

describe('mergeFields', () => {
  const base = { theme: 'dark', zoom: 1, font: 'mono' }

  it('keeps changes made on either side', () => {
    const merged = mergeFields(base, { ...base, theme: 'light' }, { ...base, zoom: 1.2 })
    expect(merged).toEqual({ theme: 'light', zoom: 1.2, font: 'mono' })
  })

  it('lets this device win when both changed the same field', () => {
    expect(mergeFields(base, { ...base, theme: 'light' }, { ...base, theme: 'blue' }).theme).toBe(
      'light',
    )
  })

  it('adopts the remote value on the first sync of a device', () => {
    expect(mergeFields(null, { theme: 'light' }, { theme: 'blue' })).toEqual({ theme: 'blue' })
  })

  it('removes a field cleared on one side', () => {
    const { font: _font, ...withoutFont } = base
    expect(mergeFields(base, withoutFont, base)).toEqual(withoutFont)
  })

  it('treats a missing field as no opinion when asked to', () => {
    const merged = mergeFields(
      base,
      { theme: 'dark' },
      { ...base, zoom: 2 },
      { absentIsNoOpinion: true },
    )
    expect(merged).toEqual({ theme: 'dark', zoom: 2, font: 'mono' })
  })
})

describe('mergeKeyed', () => {
  const a = { id: 'a', name: 'A' }
  const b = { id: 'b', name: 'B' }

  it('unions additions from both sides', () => {
    const merged = mergeKeyed({ a }, { a, b }, { a, c: { id: 'c', name: 'C' } })
    expect(Object.keys(merged).sort()).toEqual(['a', 'b', 'c'])
  })

  it('propagates a deletion when the other side did not touch the entry', () => {
    expect(mergeKeyed({ a, b }, { a }, { a, b })).toEqual({ a })
    expect(mergeKeyed({ a, b }, { a, b }, { a })).toEqual({ a })
  })

  it('keeps an entry deleted on one side but edited on the other', () => {
    const edited = { id: 'b', name: 'B2' }
    expect(mergeKeyed({ a, b }, { a }, { a, b: edited })).toEqual({ a, b: edited })
    expect(mergeKeyed({ a, b }, { a, b: edited }, { a })).toEqual({ a, b: edited })
  })

  it('never deletes without a base', () => {
    expect(Object.keys(mergeKeyed(null, { a }, { b })).sort()).toEqual(['a', 'b'])
  })

  it('merges fields of entries present on both sides', () => {
    const base = { a: { id: 'a', name: 'A', color: 'red' } }
    const merged = mergeKeyed(
      base,
      { a: { ...base.a, name: 'Local' } },
      { a: { ...base.a, color: 'blue' } },
    )
    expect(merged.a).toEqual({ id: 'a', name: 'Local', color: 'blue' })
  })
})
