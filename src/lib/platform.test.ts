import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatShortcut, isLinux, isMacOS, normalizeCwd, shouldUseNativeBackend } from './platform'

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

describe('isMacOS', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects macOS from the WKWebView user-agent', () => {
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

describe('isLinux', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects desktop Linux', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    expect(isLinux()).toBe(true)
  })

  it('is false on Windows and macOS', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    expect(isLinux()).toBe(false)
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(isLinux()).toBe(false)
  })

  it('is false on Android (Linux UA substring)', () => {
    setUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36')
    expect(isLinux()).toBe(false)
  })
})

describe('shouldUseNativeBackend', () => {
  it('uses native only when the flag is on AND on macOS', () => {
    expect(shouldUseNativeBackend(true, true)).toBe(true)
  })

  it('does not use native without the flag, even on macOS', () => {
    expect(shouldUseNativeBackend(false, true)).toBe(false)
    expect(shouldUseNativeBackend(undefined, true)).toBe(false)
  })

  it('never uses native outside macOS, even with the flag on', () => {
    // Windows/Linux must never take the native path — central requirement.
    expect(shouldUseNativeBackend(true, false)).toBe(false)
  })
})

describe('normalizeCwd', () => {
  it('strips a trailing slash', () => {
    expect(normalizeCwd('/home/user/project/')).toBe('/home/user/project')
  })

  it('normalizes separator and case only for Windows drive-letter paths', () => {
    expect(normalizeCwd('C:/Users/Miguel/Project/')).toBe('c:\\users\\miguel\\project')
    expect(normalizeCwd('C:\\Users\\Miguel\\Project')).toBe('c:\\users\\miguel\\project')
  })

  it('preserves case and separators on Unix paths (case-sensitive)', () => {
    // No drive letter: must not lowercase, or /home/user/Project and
    // /home/user/project (DIFFERENT directories on Linux) would collide.
    expect(normalizeCwd('/home/user/Project')).toBe('/home/user/Project')
    expect(normalizeCwd('/home/user/project')).toBe('/home/user/project')
  })

  it('strips the verbatim \\\\?\\ prefix before comparing, otherwise worktrees never match the real path', () => {
    expect(normalizeCwd('\\\\?\\D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x')).toBe(
      normalizeCwd('D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x'),
    )
  })

  it('strips the verbatim UNC \\\\?\\UNC\\ prefix', () => {
    expect(normalizeCwd('\\\\?\\UNC\\server\\share\\project')).toBe('\\\\server\\share\\project')
  })
})

describe('formatShortcut', () => {
  it('returns the original text outside macOS', () => {
    expect(formatShortcut('Ctrl+Shift+P', false)).toBe('Ctrl+Shift+P')
  })

  it('converts to macOS glyphs', () => {
    expect(formatShortcut('Ctrl+T', true)).toBe('⌘T')
    expect(formatShortcut('Ctrl+Shift+P', true)).toBe('⌘⇧P')
    expect(formatShortcut('Ctrl+Shift+G', true)).toBe('⌘⇧G')
  })
})
