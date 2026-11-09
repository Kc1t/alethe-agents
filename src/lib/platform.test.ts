import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatShortcut, isLinux, isMacOS, isWindows, normalizeCwd, shouldUseNativeBackend } from './platform'

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

describe('isMacOS', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects macOS from WKWebView user-agent', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(isMacOS()).toBe(true)
  })

  it('is false on Windows', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    expect(isMacOS()).toBe(false)
  })

  it('is false on Linux', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    expect(isMacOS()).toBe(false)
  })
})

describe('isWindows', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects Windows from user-agent', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    expect(isWindows()).toBe(true)
  })

  it('is false on Linux', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    expect(isWindows()).toBe(false)
  })

  it('is false on macOS', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(isWindows()).toBe(false)
  })
})

describe('isLinux', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects Linux from WebKitGTK user-agent', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)')
    expect(isLinux()).toBe(true)
  })

  it('is false on macOS', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(isLinux()).toBe(false)
  })

  it('is false on Windows', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    expect(isLinux()).toBe(false)
  })

  it('is false on Android', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36')
    expect(isLinux()).toBe(false)
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
