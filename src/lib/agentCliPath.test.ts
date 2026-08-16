import { describe, expect, it } from 'vitest'

import { cliPathMatchesAgent } from './agentCliPath'

describe('cliPathMatchesAgent', () => {
  it('accepts the Antigravity CLI and rejects the desktop application', () => {
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Tools\agy.exe`)).toBe(true)
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Apps\Antigravity.exe`)).toBe(false)
  })

  it('accepts Windows launcher extensions for GitHub Copilot', () => {
    expect(cliPathMatchesAgent('copilot', String.raw`C:\npm\copilot.cmd`)).toBe(true)
  })
})
