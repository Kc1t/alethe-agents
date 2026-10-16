import { describe, expect, it } from 'vitest'

import { decodeOsc52 } from './osc52'

const encode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))

describe('decodeOsc52', () => {
  it('decodes a clipboard write, UTF-8 included', () => {
    expect(decodeOsc52(`c;${encode('Resumo da conversa — falada.')}`)).toBe(
      'Resumo da conversa — falada.',
    )
    expect(decodeOsc52(`;${encode('hi')}`)).toBe('hi')
  })

  // A query would hand the clipboard to whatever runs in the terminal.
  it('ignores queries, empty and malformed payloads', () => {
    expect(decodeOsc52('c;?')).toBeNull()
    expect(decodeOsc52('c;')).toBeNull()
    expect(decodeOsc52('no-separator')).toBeNull()
    expect(decodeOsc52('c;***')).toBeNull()
    expect(decodeOsc52(`c;${btoa('\xff\xfe')}`)).toBeNull()
  })
})
