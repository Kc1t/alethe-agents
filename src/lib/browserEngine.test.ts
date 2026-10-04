import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultBrowserEngine } from './browserEngine'

describe('defaultBrowserEngine', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws Linux panes through CDP', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15',
    })
    expect(defaultBrowserEngine()).toBe('cdp')
  })

  it('keeps the native webview on Windows and macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(defaultBrowserEngine()).toBe('native')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })
    expect(defaultBrowserEngine()).toBe('native')
  })
})
