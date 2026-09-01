import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatShortcut, isMacOS, normalizeCwd, shouldUseNativeBackend } from './platform'

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

describe('isMacOS', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detecta macOS pelo user-agent da WKWebView', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(isMacOS()).toBe(true)
  })

  it('é false no Windows', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    expect(isMacOS()).toBe(false)
  })

  it('é false no Linux', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    expect(isMacOS()).toBe(false)
  })
})

describe('shouldUseNativeBackend', () => {
  it('usa nativo só com flag ligada E no macOS', () => {
    expect(shouldUseNativeBackend(true, true)).toBe(true)
  })

  it('não usa nativo sem a flag, mesmo no macOS', () => {
    expect(shouldUseNativeBackend(false, true)).toBe(false)
    expect(shouldUseNativeBackend(undefined, true)).toBe(false)
  })

  it('nunca usa nativo fora do macOS, mesmo com flag ligada', () => {
                                                                                  
    expect(shouldUseNativeBackend(true, false)).toBe(false)
  })
})

describe('normalizeCwd', () => {
  it('remove barra final', () => {
    expect(normalizeCwd('/home/user/project/')).toBe('/home/user/project')
  })

  it('uniformiza separador e caixa só quando o path tem letra de drive (Windows)', () => {
    expect(normalizeCwd('C:/Users/Miguel/Project/')).toBe('c:\\users\\miguel\\project')
    expect(normalizeCwd('C:\\Users\\Miguel\\Project')).toBe('c:\\users\\miguel\\project')
  })

  it('preserva caixa e separador em paths Unix (case-sensitive)', () => {
                                                                           
                                                                      
    expect(normalizeCwd('/home/user/Project')).toBe('/home/user/Project')
    expect(normalizeCwd('/home/user/project')).toBe('/home/user/project')
  })

  it('remove o prefixo verbatim \\\\?\\ antes de comparar, senão worktrees nunca batem com o path real', () => {
    expect(normalizeCwd('\\\\?\\D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x')).toBe(
      normalizeCwd('D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x'),
    )
  })

  it('remove o prefixo verbatim UNC \\\\?\\UNC\\', () => {
    expect(normalizeCwd('\\\\?\\UNC\\server\\share\\project')).toBe('\\\\server\\share\\project')
  })
})

describe('formatShortcut', () => {
  it('retorna o texto original fora do macOS', () => {
    expect(formatShortcut('Ctrl+Shift+P', false)).toBe('Ctrl+Shift+P')
  })

  it('converte pra glifos do macOS', () => {
    expect(formatShortcut('Ctrl+T', true)).toBe('⌘T')
    expect(formatShortcut('Ctrl+Shift+P', true)).toBe('⌘⇧P')
    expect(formatShortcut('Ctrl+Shift+G', true)).toBe('⌘⇧G')
  })
})
