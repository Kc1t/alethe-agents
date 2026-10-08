import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_INSTALL_CATALOG,
  installArgv,
  installCommandLine,
  installMethodsFor,
  installShellLine,
  type InstallToolchain,
  needsNodeToolchain,
  nodeInstallMethods,
  uninstallMethodsFor,
  wslInstallMethodsFor,
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
      'winget install --accept-source-agreements --accept-package-agreements GitHub.Copilot',
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
      'winget uninstall --accept-source-agreements Anthropic.ClaudeCode',
    )
  })
})

describe('non-interactive installers', () => {
  const FULL: InstallToolchain = {
    ...BARE,
    node: 'v22.3.0',
    npm: true,
    winget: true,
    scoop: true,
    choco: true,
  }
  const agents = Object.keys(AGENT_INSTALL_CATALOG) as Array<keyof typeof AGENT_INSTALL_CATALOG>
  const installs = [
    ...agents.flatMap((agent) => installMethodsFor(agent, FULL)),
    ...nodeInstallMethods(FULL),
  ]
  const uninstalls = agents.flatMap((agent) => uninstallMethodsFor(agent, FULL))

  // The install log is read-only: a prompt there can never be answered (#235).
  it('never leaves winget or choco waiting on a confirmation prompt', () => {
    const winget = installs.filter((method) => method.id === 'winget')
    const choco = installs.filter((method) => method.id === 'choco')
    expect(winget.length).toBeGreaterThan(0)
    expect(choco.length).toBeGreaterThan(0)
    for (const method of winget) {
      expect(method.command).toContain('--accept-source-agreements')
      expect(method.command).toContain('--accept-package-agreements')
    }
    for (const method of choco) expect(method.command).toMatch(/ -y( |$)/)
  })

  it('keeps the derived uninstall commands non-interactive and aimed at the package', () => {
    expect(uninstalls.find((method) => method.id === 'winget')?.command).toBe(
      'winget uninstall --accept-source-agreements Anthropic.ClaudeCode',
    )
    expect(uninstalls.find((method) => method.id === 'choco')?.command).toBe(
      'choco uninstall opencode -y',
    )
  })
})

describe('installCommandLine', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('forwards the installer’s own exit status on Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    // Without this, PowerShell reports success for an installer that failed, and the run is
    // recorded as a working install that is not there.
    expect(installCommandLine('npm install -g opencode-ai')).toBe(
      'npm install -g opencode-ai; exit $LASTEXITCODE',
    )
  })

  it('hands a POSIX shell the bare command, whose status is already the shell’s', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(installCommandLine('npm install -g opencode-ai')).toBe('npm install -g opencode-ai')
  })
})

describe('installShellLine', () => {
  it('closes the shell so the runner can detect completion', () => {
    expect(installShellLine('npm install -g opencode-ai')).toBe(
      'npm install -g opencode-ai; exit\r',
    )
  })
})

describe('wslInstallMethodsFor', () => {
  it('keeps only the methods that also work inside a distro', () => {
    expect(wslInstallMethodsFor('claude')).toEqual([
      { id: 'npm', command: 'npm install -g @anthropic-ai/claude-code', requires: 'npm' },
    ])
    expect(wslInstallMethodsFor('opencode')).toEqual([
      { id: 'npm', command: 'npm install -g opencode-ai', requires: 'npm' },
    ])
  })

  it('yields nothing when every method is Windows-only', () => {
    expect(wslInstallMethodsFor('antigravity')).toEqual([])
  })
})

describe('installArgv', () => {
  it('splits a plain npm command into program and argv', () => {
    expect(installArgv('npm install -g @openai/codex')).toEqual({
      program: 'npm',
      args: ['install', '-g', '@openai/codex'],
    })
  })

  it('refuses commands that only a shell can run', () => {
    expect(installArgv('curl -fsSL https://example.com/i.sh | bash')).toBeNull()
    expect(installArgv('a; b')).toBeNull()
    expect(installArgv('irm https://example.com/install.ps1 | iex')).toBeNull()
    expect(installArgv('echo $HOME')).toBeNull()
    expect(installArgv('npm install -g "my pkg"')).toBeNull()
  })

  it('ignores padding and rejects an empty command', () => {
    expect(installArgv('  npm   install  -g   opencode-ai ')).toEqual({
      program: 'npm',
      args: ['install', '-g', 'opencode-ai'],
    })
    expect(installArgv('')).toBeNull()
    expect(installArgv('   ')).toBeNull()
  })
})
