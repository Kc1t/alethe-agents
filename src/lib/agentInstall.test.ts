import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installMethodsFor,
  installShellLine,
  type InstallToolchain,
  needsNodeToolchain,
  uninstallMethodsFor,
} from './agentInstall'

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  bun: false,
  pnpm: false,
}

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15'

// The catalog was written for Windows first; these cases keep describing that machine.
beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: WINDOWS_UA })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installMethodsFor', () => {
  it('offers the native installer first even when npm is available', () => {
    const methods = installMethodsFor('claude', { ...BARE, node: 'v22.3.0', npm: true })
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toContain('claude.ai/install.ps1')
  })

  it('hides npm when the machine has no npm', () => {
    const methods = installMethodsFor('codex', BARE)
    expect(methods.map((method) => method.id)).toEqual(['native'])
  })

  it('surfaces winget for Claude only when winget exists', () => {
    expect(installMethodsFor('claude', BARE).map((m) => m.id)).toEqual(['native'])
    expect(installMethodsFor('claude', { ...BARE, winget: true }).map((m) => m.id)).toEqual([
      'native',
      'winget',
    ])
  })

  it('offers the official Copilot CLI packages available on the machine', () => {
    const methods = installMethodsFor('copilot', { ...BARE, winget: true, npm: true })
    expect(methods.map((method) => method.id)).toEqual(['npm', 'winget'])
    expect(methods.map((method) => method.command)).toEqual([
      'npm install -g @github/copilot',
      'winget install GitHub.Copilot',
    ])
  })

  it('falls back to scoop and choco for OpenCode when there is no npm', () => {
    const methods = installMethodsFor('opencode', { ...BARE, scoop: true, choco: true })
    expect(methods.map((method) => method.id)).toEqual(['scoop', 'choco'])
  })

  it('returns nothing for agents without a known installer', () => {
    expect(installMethodsFor('shell', { ...BARE, npm: true })).toEqual([])
  })

  it('treats a missing toolchain probe as "only requirement-free methods"', () => {
    expect(installMethodsFor('opencode', null)).toEqual([])
    expect(installMethodsFor('antigravity', null).map((m) => m.id)).toEqual(['native'])
  })

  it('installs Cursor through its own script, with or without a toolchain', () => {
    expect(installMethodsFor('cursor', BARE).map((method) => method.id)).toEqual(['native'])
    expect(installMethodsFor('cursor', null)[0].command).toContain('cursor.com/install')
  })

  it('installs Freebuff through npm and Mimo through its own script', () => {
    expect(installMethodsFor('freebuff', { ...BARE, npm: true })[0].command).toBe(
      'npm install -g freebuff',
    )
    expect(installMethodsFor('mimo', BARE).map((method) => method.id)).toEqual(['native'])
  })

  it('installs Grok Build via native or npm, and Codewhale via npm', () => {
    expect(installMethodsFor('grok', BARE).map((method) => method.id)).toEqual(['native'])
    expect(installMethodsFor('grok', { ...BARE, npm: true }).map((method) => method.id)).toEqual([
      'native',
      'npm',
    ])
    expect(installMethodsFor('grok', { ...BARE, npm: true })[1].command).toBe(
      'npm install -g @xai-official/grok',
    )
    expect(installMethodsFor('codewhale', { ...BARE, npm: true })[0].command).toBe(
      'npm install -g codewhale',
    )
    expect(needsNodeToolchain('codewhale', BARE)).toBe(true)
    expect(needsNodeToolchain('grok', BARE)).toBe(false)
  })
})

describe('needsNodeToolchain', () => {
  it('flags npm-only agents when npm is missing', () => {
    expect(needsNodeToolchain('freebuff', BARE)).toBe(true)
    expect(needsNodeToolchain('freebuff', { ...BARE, npm: true })).toBe(false)
  })

  it('stays quiet when the agent has a installer that does not need Node', () => {
    expect(needsNodeToolchain('claude', BARE)).toBe(false)
    expect(needsNodeToolchain('mimo', BARE)).toBe(false)
  })

  it('stays quiet for agents with no installer at all', () => {
    expect(needsNodeToolchain('shell', BARE)).toBe(false)
  })

  it('flags OpenCode only when every package manager is missing', () => {
    expect(needsNodeToolchain('opencode', BARE)).toBe(true)
    expect(needsNodeToolchain('opencode', { ...BARE, scoop: true })).toBe(false)
  })
})

describe('uninstallMethodsFor', () => {
  it('derives the uninstall command from the install command', () => {
    const [method] = uninstallMethodsFor('opencode', { ...BARE, npm: true })
    expect(method.command).toBe('npm uninstall -g opencode-ai')
    expect(method.verifyAbsent).toBe(true)
  })

  it('keeps scoped package names intact', () => {
    expect(uninstallMethodsFor('codex', { ...BARE, npm: true })[0].command).toBe(
      'npm uninstall -g @openai/codex',
    )
  })

  it('never offers to undo a native install script', () => {
    expect(uninstallMethodsFor('antigravity', { ...BARE, npm: true })).toEqual([])
    expect(uninstallMethodsFor('claude', BARE)).toEqual([])
  })

  it('uses the package manager that exists on the machine', () => {
    expect(uninstallMethodsFor('opencode', { ...BARE, choco: true })[0].command).toBe(
      'choco uninstall opencode -y',
    )
    expect(uninstallMethodsFor('claude', { ...BARE, winget: true })[0].command).toBe(
      'winget uninstall Anthropic.ClaudeCode',
    )
  })
})

describe('installShellLine', () => {
  it('closes the shell so the runner can detect completion', () => {
    expect(installShellLine('npm install -g opencode-ai')).toBe(
      'npm install -g opencode-ai; exit\r',
    )
  })
})

describe('install methods on Linux', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: LINUX_UA })
  })

  it('never offers a PowerShell or Windows package-manager command', () => {
    const everything = { ...BARE, npm: true, winget: true, scoop: true, choco: true }
    for (const agent of [
      'claude',
      'codex',
      'copilot',
      'cursor',
      'antigravity',
      'mimo',
      'opencode',
      'kiro',
      'grok',
    ] as const) {
      for (const method of installMethodsFor(agent, everything)) {
        expect(method.command, agent).not.toMatch(/\b(irm|iex|winget|scoop|choco)\b/)
      }
    }
  })

  it('offers each vendor script that has a POSIX version, before npm', () => {
    const methods = installMethodsFor('claude', { ...BARE, npm: true })
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(installMethodsFor('codex', BARE)[0].command).toBe(
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    )
    expect(installMethodsFor('opencode', BARE)[0].command).toBe(
      'curl -fsSL https://opencode.ai/install | bash',
    )
  })

  it('lets Cursor, Antigravity and Kiro be installed at all', () => {
    for (const agent of ['cursor', 'antigravity', 'kiro'] as const) {
      expect(
        installMethodsFor(agent, null).map((method) => method.id),
        agent,
      ).toEqual(['native'])
    }
  })

  it('sends Mimo to npm, since its script only exists for Windows', () => {
    expect(installMethodsFor('mimo', BARE)).toEqual([])
    expect(needsNodeToolchain('mimo', BARE)).toBe(true)
    expect(installMethodsFor('mimo', { ...BARE, npm: true })[0].command).toBe(
      'npm install -g @mimo-ai/cli',
    )
  })
})
