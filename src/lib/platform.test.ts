import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  formatShortcut,
  isControlModifier,
  isMacOS,
  isPrimaryModifier,
  normalizeCwd,
  shouldUseNativeBackend,
} from './platform'

function setUserAgent(ua: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

describe('isMacOS', () => {
  afterEach(() => vi.restoreAllMocks())

  it('detects macOS from the WKWebView user agent', () => {
    setUserAgent(MAC_UA)
    expect(isMacOS()).toBe(true)
  })

  it('is false on Windows', () => {
    setUserAgent(WINDOWS_UA)
    expect(isMacOS()).toBe(false)
  })

  it('is false on Linux', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36')
    expect(isMacOS()).toBe(false)
  })
})

describe('shouldUseNativeBackend', () => {
  it('uses the native backend only with the flag on AND on macOS', () => {
    expect(shouldUseNativeBackend(true, true)).toBe(true)
  })

  it('does not use the native backend without the flag, even on macOS', () => {
    expect(shouldUseNativeBackend(false, true)).toBe(false)
    expect(shouldUseNativeBackend(undefined, true)).toBe(false)
  })

  it('never uses the native backend outside macOS, even with the flag on', () => {
    expect(shouldUseNativeBackend(true, false)).toBe(false)
  })
})

describe('normalizeCwd', () => {
  it('drops the trailing separator', () => {
    expect(normalizeCwd('/home/user/project/')).toBe('/home/user/project')
  })

  it('normalizes separator and case only for drive-letter (Windows) paths', () => {
    expect(normalizeCwd('C:/Users/Miguel/Project/')).toBe('c:\\users\\miguel\\project')
    expect(normalizeCwd('C:\\Users\\Miguel\\Project')).toBe('c:\\users\\miguel\\project')
  })

  it('keeps case and separators of Unix paths (case-sensitive)', () => {
    expect(normalizeCwd('/home/user/Project')).toBe('/home/user/Project')
    expect(normalizeCwd('/home/user/project')).toBe('/home/user/project')
  })

  it('strips the verbatim \\\\?\\ prefix, or worktrees never match the real path', () => {
    expect(normalizeCwd('\\\\?\\D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x')).toBe(
      normalizeCwd('D:\\Projetos\\PICLESV2\\.alethe\\worktrees\\opencode-x'),
    )
  })

  it('strips the verbatim UNC prefix \\\\?\\UNC\\', () => {
    expect(normalizeCwd('\\\\?\\UNC\\server\\share\\project')).toBe('\\\\server\\share\\project')
  })
})

const NONE = { ctrlKey: false, metaKey: false }
const CTRL = { ctrlKey: true, metaKey: false }
const META = { ctrlKey: false, metaKey: true }
const BOTH = { ctrlKey: true, metaKey: true }

describe('isPrimaryModifier', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is Cmd alone on macOS, so a physical Ctrl chord stays with the terminal', () => {
    expect(isPrimaryModifier(META, true)).toBe(true)
    expect(isPrimaryModifier(CTRL, true)).toBe(false)
    expect(isPrimaryModifier(BOTH, true)).toBe(false)
    expect(isPrimaryModifier(NONE, true)).toBe(false)
  })

  it('keeps accepting Ctrl or the Windows/Super key elsewhere', () => {
    expect(isPrimaryModifier(CTRL, false)).toBe(true)
    expect(isPrimaryModifier(META, false)).toBe(true)
    expect(isPrimaryModifier(BOTH, false)).toBe(true)
    expect(isPrimaryModifier(NONE, false)).toBe(false)
  })

  it('reads the platform from the user agent by default', () => {
    setUserAgent(MAC_UA)
    expect(isPrimaryModifier(CTRL)).toBe(false)
    expect(isPrimaryModifier(META)).toBe(true)
    vi.restoreAllMocks()
    setUserAgent(WINDOWS_UA)
    expect(isPrimaryModifier(CTRL)).toBe(true)
  })
})

describe('isControlModifier', () => {
  it('is the physical Ctrl key on macOS, where Cmd+Tab belongs to the OS', () => {
    expect(isControlModifier(CTRL, true)).toBe(true)
    expect(isControlModifier(META, true)).toBe(false)
    expect(isControlModifier(BOTH, true)).toBe(false)
  })

  it('matches the primary modifier elsewhere', () => {
    expect(isControlModifier(CTRL, false)).toBe(true)
    expect(isControlModifier(META, false)).toBe(true)
    expect(isControlModifier(NONE, false)).toBe(false)
  })
})

describe('formatShortcut', () => {
  it('returns the original text outside macOS', () => {
    expect(formatShortcut('Ctrl+Shift+P', false)).toBe('Ctrl+Shift+P')
    expect(formatShortcut('Ctrl+Tab', false)).toBe('Ctrl+Tab')
  })

  it('converts to macOS glyphs', () => {
    expect(formatShortcut('Ctrl+T', true)).toBe('⌘T')
    expect(formatShortcut('Ctrl+Shift+P', true)).toBe('⌘⇧P')
    expect(formatShortcut('Ctrl+Shift+G', true)).toBe('⌘⇧G')
  })

  it('keeps Ctrl+Tab on the Control glyph, since Cmd+Tab is the app switcher', () => {
    expect(formatShortcut('Ctrl+Tab', true)).toBe('⌃Tab')
    expect(formatShortcut('Ctrl+Shift+Tab', true)).toBe('⌃⇧Tab')
  })
})
