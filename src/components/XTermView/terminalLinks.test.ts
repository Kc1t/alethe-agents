import { describe, expect, it } from 'vitest'

import { detectTerminalLinks, getLogicalTerminalLine, terminalLinkRange } from './terminalLinks'

describe('terminal links', () => {
  it('ends URLs at whitespace while preserving spaces inside local paths', () => {
    expect(detectTerminalLinks('https://github.com/login/device in your browser...')).toEqual([
      expect.objectContaining({
        text: 'https://github.com/login/device',
        displayLength: 'https://github.com/login/device'.length,
      }),
    ])
    expect(detectTerminalLinks('(https://github.com/login/device in your browser)')[0].text).toBe(
      'https://github.com/login/device',
    )
    expect(detectTerminalLinks('D:\\public launch\\src\\file.ts')).toEqual([
      expect.objectContaining({ text: 'D:\\public launch\\src\\file.ts', kind: 'path' }),
    ])
    expect(
      detectTerminalLinks('"D:\\tmp\\shot-lab-strips\\ um PNG por shot, nome = slug."')[0],
    ).toEqual(
      expect.objectContaining({
        text: 'D:\\tmp\\shot-lab-strips\\',
        target: 'D:\\tmp\\shot-lab-strips\\',
        kind: 'path',
      }),
    )
  })

  it('detects mixed-case protocols and bare deployment domains', () => {
    const links = detectTerminalLinks(
      'Deploy em verzel-elite-dev-painel.vercel.app (Https://verzel-elite-dev-painel.vercel.app).',
    )

    expect(links).toEqual([
      expect.objectContaining({
        text: 'verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
      expect.objectContaining({
        text: 'Https://verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
    ])
    expect(detectTerminalLinks('localhost:5173/dashboard')[0]).toEqual(
      expect.objectContaining({ target: 'http://localhost:5173/dashboard', kind: 'url' }),
    )
  })

  it('reconstructs viewport-wrapped lines and creates a multiline range', () => {
    const values = [
      { value: 'go https:/', isWrapped: false },
      { value: '/example.c', isWrapped: true },
      { value: 'om/docs', isWrapped: true },
    ]
    const buffer = {
      length: values.length,
      getLine: (index: number) => {
        const line = values[index]
        return line ? { isWrapped: line.isWrapped, translateToString: () => line.value } : undefined
      },
    }

    const logicalLine = getLogicalTerminalLine(buffer, 2)
    expect(logicalLine).toEqual({ text: 'go https://example.com/docs', startLine: 1 })
    const [link] = detectTerminalLinks(logicalLine!.text)
    expect(terminalLinkRange(logicalLine!.startLine, 10, link)).toEqual({
      start: { x: 4, y: 1 },
      end: { x: 7, y: 3 },
    })
  })

  it('keeps escaped spaces in the visual range and unescapes the opened path', () => {
    const [link] = detectTerminalLinks('/tmp/my\\ file/readme.md')
    expect(link.text).toBe('/tmp/my file/readme.md')
    expect(link.displayLength).toBe('/tmp/my\\ file/readme.md'.length)
    expect(link.fileKind).toBe('markdown')
  })

  it('classifies path links by extension', () => {
    expect(detectTerminalLinks('/tmp/shot.png')[0].fileKind).toBe('image')
    expect(detectTerminalLinks('/tmp/main.ts:42:10')[0].fileKind).toBe('text')
    expect(detectTerminalLinks('/tmp/notes.md')[0].fileKind).toBe('markdown')
    expect(detectTerminalLinks('/tmp/trailer.mp4')[0].fileKind).toBe('video')
    expect(
      detectTerminalLinks(
        'Jogado em D:\\kauam\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md com as duas projeções',
      )[0].text,
    ).toBe('D:\\kauam\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md')
    expect(
      detectTerminalLinks('D:\\kauam\\Videos\\motion-kit-hype-video.mp4 e escuta')[0].text,
    ).toBe('D:\\kauam\\Videos\\motion-kit-hype-video.mp4')
    expect(detectTerminalLinks('https://example.com/x')[0].fileKind).toBeUndefined()
  })

  it('does not turn prose slashes into links', () => {
    expect(detectTerminalLinks('/ Zambia / India')).toEqual([])
    expect(detectTerminalLinks('IP residencial/mobile + UA')).toEqual([])
    expect(detectTerminalLinks('foo/bar')).toEqual([])
    expect(detectTerminalLinks('src/file.ts package.json user@example.com')).toEqual([])
  })
})
