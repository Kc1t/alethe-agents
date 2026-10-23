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

const WIN = 'windows' as const

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  brew: false,
  bun: false,
  pnpm: false,
}

describe('installMethodsFor', () => {
  it('offers the native installer first even when npm is available', () => {
    const methods = installMethodsFor('claude', { ...BARE, node: 'v22.3.0', npm: true }, WIN)
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toContain('claude.ai/install.ps1')
  })

  it('hides npm when the machine has no npm', () => {
    const methods = installMethodsFor('codex', BARE, WIN)
    expect(methods.map((method) => method.id)).toEqual(['native'])
  })

  it('surfaces winget for Claude only when winget exists', () => {
    expect(installMethodsFor('claude', BARE, WIN).map((m) => m.id)).toEqual(['native'])
    expect(installMethodsFor('claude', { ...BARE, winget: true }, WIN).map((m) => m.id)).toEqual([
      'native',
      'winget',
    ])
  })

  it('offers the official Copilot CLI packages available on the machine', () => {
    const methods = installMethodsFor('copilot', { ...BARE, winget: true, npm: true }, WIN)
    expect(methods.map((method) => method.id)).toEqual(['npm', 'winget'])
    expect(methods.map((method) => method.command)).toEqual([
      'npm install -g @github/copilot',
      'winget install --accept-source-agreements --accept-package-agreements GitHub.Copilot',
    ])
  })

  it('falls back to scoop and choco for OpenCode when there is no npm', () => {
    const methods = installMethodsFor('opencode', { ...BARE, scoop: true, choco: true }, WIN)
    expect(methods.map((method) => method.id)).toEqual(['scoop', 'choco'])
  })

  it('returns nothing for agents without a known installer', () => {
    expect(installMethodsFor('shell', { ...BARE, npm: true }, WIN)).toEqual([])
  })

  it('treats a missing toolchain probe as "only requirement-free methods"', () => {
    expect(installMethodsFor('opencode', null, WIN)).toEqual([])
    expect(installMethodsFor('antigravity', null, WIN).map((m) => m.id)).toEqual(['native'])
  })

  it('installs Cursor through its own script, with or without a toolchain', () => {
    expect(installMethodsFor('cursor', BARE, WIN).map((method) => method.id)).toEqual(['native'])
    expect(installMethodsFor('cursor', null, WIN)[0].command).toContain('cursor.com/install')
  })

  it('installs Freebuff through npm and Mimo through its own script', () => {
    expect(installMethodsFor('freebuff', { ...BARE, npm: true }, WIN)[0].command).toBe(
      'npm install -g freebuff',
    )
    expect(installMethodsFor('mimo', BARE, WIN).map((method) => method.id)).toEqual(['native'])
  })

  it('installs Grok Build via native or npm, and Codewhale via npm', () => {
    expect(installMethodsFor('grok', BARE, WIN).map((method) => method.id)).toEqual(['native'])
    expect(
      installMethodsFor('grok', { ...BARE, npm: true }, WIN).map((method) => method.id),
    ).toEqual(['native', 'npm'])
    expect(installMethodsFor('grok', { ...BARE, npm: true }, WIN)[1].command).toBe(
      'npm install -g @xai-official/grok',
    )
    expect(installMethodsFor('codewhale', { ...BARE, npm: true }, WIN)[0].command).toBe(
      'npm install -g codewhale',
    )
    expect(needsNodeToolchain('codewhale', BARE, WIN)).toBe(true)
    expect(needsNodeToolchain('grok', BARE, WIN)).toBe(false)
  })
})

describe('needsNodeToolchain', () => {
  it('flags npm-only agents when npm is missing', () => {
    expect(needsNodeToolchain('freebuff', BARE, WIN)).toBe(true)
    expect(needsNodeToolchain('freebuff', { ...BARE, npm: true }, WIN)).toBe(false)
  })

  it('stays quiet when the agent has a installer that does not need Node', () => {
    expect(needsNodeToolchain('claude', BARE, WIN)).toBe(false)
    expect(needsNodeToolchain('mimo', BARE, WIN)).toBe(false)
  })

  it('stays quiet for agents with no installer at all', () => {
    expect(needsNodeToolchain('shell', BARE, WIN)).toBe(false)
  })

  it('flags OpenCode only when every package manager is missing', () => {
    expect(needsNodeToolchain('opencode', BARE, WIN)).toBe(true)
    expect(needsNodeToolchain('opencode', { ...BARE, scoop: true }, WIN)).toBe(false)
  })
})

describe('uninstallMethodsFor', () => {
  it('derives the uninstall command from the install command', () => {
    const [method] = uninstallMethodsFor('opencode', { ...BARE, npm: true }, WIN)
    expect(method.command).toBe('npm uninstall -g opencode-ai')
    expect(method.verifyAbsent).toBe(true)
  })

  it('keeps scoped package names intact', () => {
    expect(uninstallMethodsFor('codex', { ...BARE, npm: true }, WIN)[0].command).toBe(
      'npm uninstall -g @openai/codex',
    )
  })

  it('never offers to undo a native install script', () => {
    expect(uninstallMethodsFor('antigravity', { ...BARE, npm: true }, WIN)).toEqual([])
    expect(uninstallMethodsFor('claude', BARE, WIN)).toEqual([])
  })

  it('uses the package manager that exists on the machine', () => {
    expect(uninstallMethodsFor('opencode', { ...BARE, choco: true }, WIN)[0].command).toBe(
      'choco uninstall opencode -y',
    )
    expect(uninstallMethodsFor('claude', { ...BARE, winget: true }, WIN)[0].command).toBe(
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
    ...agents.flatMap((agent) => installMethodsFor(agent, FULL, WIN)),
    ...nodeInstallMethods(FULL, WIN),
  ]
  const uninstalls = agents.flatMap((agent) => uninstallMethodsFor(agent, FULL, WIN))

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

describe('macOS and Linux installers', () => {
  const MAC = 'macos' as const
  const LINUX = 'linux' as const
  const agents = Object.keys(AGENT_INSTALL_CATALOG) as Array<keyof typeof AGENT_INSTALL_CATALOG>
  const EVERYTHING: InstallToolchain = {
    ...BARE,
    node: 'v22.3.0',
    npm: true,
    winget: true,
    scoop: true,
    choco: true,
    brew: true,
  }
  const POWERSHELL = /\b(irm|iwr|iex)\b/i

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('never offers a PowerShell or Windows-only method on a POSIX shell', () => {
    for (const platform of [MAC, LINUX]) {
      const methods = [
        ...agents.flatMap((agent) => installMethodsFor(agent, EVERYTHING, platform)),
        ...agents.flatMap((agent) => uninstallMethodsFor(agent, EVERYTHING, platform)),
        ...nodeInstallMethods(EVERYTHING, platform),
      ]
      expect(methods.length).toBeGreaterThan(0)
      for (const method of methods) {
        expect(method.command).not.toMatch(POWERSHELL)
        expect(['winget', 'scoop', 'choco']).not.toContain(method.id)
      }
    }
  })

  it('keeps Windows on its own catalog even when Homebrew is reported', () => {
    for (const agent of agents) {
      const methods = installMethodsFor(agent, EVERYTHING, WIN)
      for (const method of methods) {
        expect(method.id).not.toBe('brew')
        expect(method.command).not.toMatch(/\bcurl\b/)
      }
    }
    expect(nodeInstallMethods({ ...BARE, brew: true }, WIN)).toEqual([])
  })

  it('defaults every agent on a bare Mac to a POSIX installer or to Node', () => {
    for (const agent of agents) {
      const [first] = installMethodsFor(agent, BARE, MAC)
      if (first) {
        expect(first.id).toBe('native')
        expect(first.command).toMatch(/^curl .*\| (\w+=\S+ )?(ba)?sh$/)
      } else {
        expect(needsNodeToolchain(agent, BARE, MAC)).toBe(true)
      }
    }
  })

  it('runs the official POSIX scripts', () => {
    const native = (agent: keyof typeof AGENT_INSTALL_CATALOG) =>
      installMethodsFor(agent, BARE, MAC)[0]?.command
    expect(native('claude')).toBe('curl -fsSL https://claude.ai/install.sh | bash')
    expect(native('cursor')).toBe('curl https://cursor.com/install -fsS | bash')
    expect(native('opencode')).toBe('curl -fsSL https://opencode.ai/install | bash')
    expect(native('antigravity')).toBe(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    )
    // Its closing "Start Codex now?" prompt would hang the read-only log.
    expect(native('codex')).toBe(
      'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
    )
  })

  it('orders native, npm and Homebrew, and offers casks only on macOS', () => {
    const toolchain = { ...BARE, npm: true, brew: true }
    expect(installMethodsFor('claude', toolchain, MAC).map((m) => m.id)).toEqual([
      'native',
      'npm',
      'brew',
    ])
    expect(installMethodsFor('copilot', { ...BARE, brew: true }, MAC)).toMatchObject([
      { id: 'brew', command: 'brew install --cask copilot-cli' },
    ])
    expect(installMethodsFor('copilot', { ...BARE, brew: true }, LINUX)).toEqual([])
    expect(installMethodsFor('opencode', { ...BARE, brew: true }, LINUX).map((m) => m.id)).toEqual([
      'native',
      'brew',
    ])
  })

  it('asks for Node on a Mac only when nothing else can install the agent', () => {
    expect(needsNodeToolchain('copilot', BARE, MAC)).toBe(true)
    expect(needsNodeToolchain('copilot', { ...BARE, brew: true }, MAC)).toBe(false)
    expect(needsNodeToolchain('opencode', BARE, MAC)).toBe(false)
    expect(nodeInstallMethods(BARE, MAC)).toEqual([])
    expect(nodeInstallMethods({ ...BARE, brew: true }, MAC)).toMatchObject([
      { id: 'brew', command: 'brew install node', verifyCommand: 'npm' },
    ])
  })

  it('derives Homebrew uninstalls, keeping casks and tap names intact', () => {
    const brewOnly = { ...BARE, brew: true }
    expect(uninstallMethodsFor('claude', brewOnly, MAC)).toMatchObject([
      { id: 'brew', command: 'brew uninstall --cask claude-code', verifyAbsent: true },
    ])
    expect(uninstallMethodsFor('opencode', brewOnly, MAC)[0].command).toBe(
      'brew uninstall anomalyco/tap/opencode',
    )
    expect(uninstallMethodsFor('cursor', brewOnly, MAC)).toEqual([])
  })

  it('picks the catalog for the OS the app runs on', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(installMethodsFor('claude', BARE)[0].command).toContain('claude.ai/install.sh')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(installMethodsFor('kiro', BARE)[0].command).toContain('cli.kiro.dev/install |')
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(installMethodsFor('claude', BARE)[0].command).toContain('claude.ai/install.ps1')
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
