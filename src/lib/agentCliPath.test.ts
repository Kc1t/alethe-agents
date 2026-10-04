import { afterEach, describe, expect, it, vi } from 'vitest'

import { cliExecutableFilters, cliPathMatchesAgent } from './agentCliPath'

describe('cliPathMatchesAgent', () => {
  it('accepts the Antigravity CLI and rejects the desktop application', () => {
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Tools\agy.exe`)).toBe(true)
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Apps\Antigravity.exe`)).toBe(false)
  })

  it('accepts the Cursor CLI and rejects the editor binary', () => {
    expect(cliPathMatchesAgent('cursor', String.raw`C:\Users\me\.local\bin\cursor-agent.exe`)).toBe(
      true,
    )
    expect(cliPathMatchesAgent('cursor', String.raw`C:\Programs\cursor\Cursor.exe`)).toBe(false)
  })

  it('accepts Windows launcher extensions for GitHub Copilot', () => {
    expect(cliPathMatchesAgent('copilot', String.raw`C:\npm\copilot.cmd`)).toBe(true)
  })
})

describe('cliExecutableFilters', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('narrows to launcher extensions on Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(cliExecutableFilters()?.[0].extensions).toEqual(['cmd', 'exe', 'bat', 'ps1'])
  })

  it('applies no filter on Linux, where CLI binaries have no extension', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15',
    })
    expect(cliExecutableFilters()).toBeUndefined()
  })
})
