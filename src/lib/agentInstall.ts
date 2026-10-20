import { isMacOS, isWindows } from './platform'
import type { AgentType } from './types'

export type InstallToolchain = {
  node: string | null
  npm: boolean
  winget: boolean
  scoop: boolean
  choco: boolean
  brew: boolean
  bun: boolean
  pnpm: boolean
}

export type InstallMethodId = 'native' | 'npm' | 'brew' | 'winget' | 'scoop' | 'choco'

export type InstallPlatform = 'windows' | 'macos' | 'linux'

export type InstallMethod = {
  id: InstallMethodId
  command: string
  requires?: keyof InstallToolchain
  /** Operating systems the command runs on. Omitted means everywhere (npm). */
  platforms?: readonly InstallPlatform[]
  /**
   * CLI to probe to decide whether the install worked. Defaults to the agent's own command; a
   * toolchain install (Node) has to be verified against the toolchain instead.
   */
  verifyCommand?: string
  /** Inverts the check: the run succeeded when the CLI is gone, not when it is found. */
  verifyAbsent?: boolean
}

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'

export type AgentInstallCatalogEntry = {
  docsUrl: string
  methods: InstallMethod[]
}

const METHOD_ORDER: InstallMethodId[] = ['native', 'npm', 'brew', 'winget', 'scoop', 'choco']

const WINDOWS: readonly InstallPlatform[] = ['windows']
const UNIX: readonly InstallPlatform[] = ['macos', 'linux']
// Homebrew casks only exist on macOS; formulae also install through Homebrew on Linux.
const MACOS: readonly InstallPlatform[] = ['macos']

export function currentInstallPlatform(): InstallPlatform {
  if (isWindows()) return 'windows'
  return isMacOS() ? 'macos' : 'linux'
}

// Commands are fixed literals, never user input: they are handed straight to a
// shell PTY. Verified against each vendor's official install documentation. A vendor script comes
// as PowerShell for Windows and POSIX sh/bash for macOS and Linux, so `native` can appear per OS.
// The install log is read-only, so a command must never stop on a prompt: winget asks to accept
// its source agreements on first use and choco asks before running a package script. The package
// id stays last because the uninstall command is derived from it.
export const AGENT_INSTALL_CATALOG: Partial<Record<AgentType, AgentInstallCatalogEntry>> = {
  claude: {
    docsUrl: 'https://code.claude.com/docs/en/setup',
    methods: [
      { id: 'native', command: 'irm https://claude.ai/install.ps1 | iex', platforms: WINDOWS },
      {
        id: 'native',
        command: 'curl -fsSL https://claude.ai/install.sh | bash',
        platforms: UNIX,
      },
      {
        id: 'winget',
        command:
          'winget install --accept-source-agreements --accept-package-agreements Anthropic.ClaudeCode',
        requires: 'winget',
        platforms: WINDOWS,
      },
      {
        id: 'brew',
        command: 'brew install --cask claude-code',
        requires: 'brew',
        platforms: MACOS,
      },
      { id: 'npm', command: 'npm install -g @anthropic-ai/claude-code', requires: 'npm' },
    ],
  },
  codex: {
    docsUrl: 'https://github.com/openai/codex',
    methods: [
      {
        id: 'native',
        command: 'irm https://chatgpt.com/codex/install.ps1 | iex',
        platforms: WINDOWS,
      },
      // The script ends by asking "Start Codex now?", which the read-only log cannot answer.
      {
        id: 'native',
        command: 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh',
        platforms: UNIX,
      },
      { id: 'npm', command: 'npm install -g @openai/codex', requires: 'npm' },
      { id: 'brew', command: 'brew install --cask codex', requires: 'brew', platforms: MACOS },
    ],
  },
  copilot: {
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    methods: [
      {
        id: 'winget',
        command:
          'winget install --accept-source-agreements --accept-package-agreements GitHub.Copilot',
        requires: 'winget',
        platforms: WINDOWS,
      },
      { id: 'npm', command: 'npm install -g @github/copilot', requires: 'npm' },
      {
        id: 'brew',
        command: 'brew install --cask copilot-cli',
        requires: 'brew',
        platforms: MACOS,
      },
    ],
  },
  cursor: {
    docsUrl: 'https://cursor.com/docs/cli/installation',
    methods: [
      {
        id: 'native',
        command: "irm 'https://cursor.com/install?win32=true' | iex",
        platforms: WINDOWS,
      },
      { id: 'native', command: 'curl https://cursor.com/install -fsS | bash', platforms: UNIX },
    ],
  },
  antigravity: {
    docsUrl: 'https://antigravity.google/docs/cli/install',
    methods: [
      {
        id: 'native',
        command: 'irm https://antigravity.google/cli/install.ps1 | iex',
        platforms: WINDOWS,
      },
      {
        id: 'native',
        command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        platforms: UNIX,
      },
    ],
  },
  mimo: {
    docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code',
    methods: [
      {
        id: 'native',
        command: 'irm https://mimo.xiaomi.com/install.ps1 | iex',
        platforms: WINDOWS,
      },
      {
        id: 'native',
        command: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
        platforms: UNIX,
      },
      { id: 'npm', command: 'npm install -g @mimo-ai/cli', requires: 'npm' },
    ],
  },
  freebuff: {
    docsUrl: 'https://freebuff.com',
    methods: [{ id: 'npm', command: 'npm install -g freebuff', requires: 'npm' }],
  },
  opencode: {
    docsUrl: 'https://opencode.ai/docs/',
    methods: [
      { id: 'native', command: 'curl -fsSL https://opencode.ai/install | bash', platforms: UNIX },
      { id: 'npm', command: 'npm install -g opencode-ai', requires: 'npm' },
      // The vendor's own tap ships releases sooner than homebrew-core; the full name trusts only
      // this formula, so Homebrew 6+ does not stop to ask about the tap.
      {
        id: 'brew',
        command: 'brew install anomalyco/tap/opencode',
        requires: 'brew',
        platforms: UNIX,
      },
      { id: 'scoop', command: 'scoop install opencode', requires: 'scoop', platforms: WINDOWS },
      { id: 'choco', command: 'choco install -y opencode', requires: 'choco', platforms: WINDOWS },
    ],
  },
  kiro: {
    docsUrl: 'https://kiro.dev/cli/',
    methods: [
      { id: 'native', command: "irm 'https://cli.kiro.dev/install.ps1' | iex", platforms: WINDOWS },
      { id: 'native', command: 'curl -fsSL https://cli.kiro.dev/install | bash', platforms: UNIX },
    ],
  },
  kimi: {
    docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
    methods: [
      {
        id: 'native',
        command: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
        platforms: UNIX,
      },
      { id: 'npm', command: 'npm install -g @moonshot-ai/kimi-code', requires: 'npm' },
    ],
  },
  grok: {
    docsUrl: 'https://docs.x.ai/build/overview',
    methods: [
      { id: 'native', command: 'irm https://x.ai/cli/install.ps1 | iex', platforms: WINDOWS },
      { id: 'native', command: 'curl -fsSL https://x.ai/cli/install.sh | bash', platforms: UNIX },
      { id: 'npm', command: 'npm install -g @xai-official/grok', requires: 'npm' },
    ],
  },
  codewhale: {
    docsUrl: 'https://codewhale.net/en',
    methods: [
      {
        id: 'native',
        command: 'curl -fsSL https://codewhale.net/install.sh | sh',
        platforms: UNIX,
      },
      { id: 'npm', command: 'npm install -g codewhale', requires: 'npm' },
      {
        id: 'brew',
        command: 'brew install Hmbown/deepseek-tui/codewhale',
        requires: 'brew',
        platforms: UNIX,
      },
    ],
  },
}

export function installDocsUrl(agent: AgentType): string | undefined {
  return AGENT_INSTALL_CATALOG[agent]?.docsUrl
}

// PowerShell-only installer shapes: `irm`/`iwr` and their full cmdlet names, piped into `iex`.
const POWERSHELL_INSTALLER =
  /(^|[\s|])(irm|iwr|iex|invoke-restmethod|invoke-webrequest|invoke-expression)([\s|]|$)/i

const WINDOWS_ONLY_METHODS: InstallMethodId[] = ['winget', 'scoop', 'choco']

function runsOn(method: InstallMethod, platform: InstallPlatform): boolean {
  if (method.platforms && !method.platforms.includes(platform)) return false
  // Belt and braces for a catalog entry missing its tag: a POSIX shell cannot run any of these.
  if (platform === 'windows') return true
  return !WINDOWS_ONLY_METHODS.includes(method.id) && !POWERSHELL_INSTALLER.test(method.command)
}

function availableMethods(
  methods: InstallMethod[],
  toolchain: InstallToolchain | null,
  platform: InstallPlatform,
): InstallMethod[] {
  return methods.filter((method) => {
    if (!runsOn(method, platform)) return false
    if (!method.requires) return true
    if (!toolchain) return false
    return Boolean(toolchain[method.requires])
  })
}

/**
 * Methods that will actually work on this machine, best first. A method without
 * `requires` needs nothing beyond a shell, so it qualifies on every OS it is tagged for.
 */
export function installMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  platform: InstallPlatform = currentInstallPlatform(),
): InstallMethod[] {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry) return []
  return availableMethods(entry.methods, toolchain, platform).sort(
    (a, b) => METHOD_ORDER.indexOf(a.id) - METHOD_ORDER.indexOf(b.id),
  )
}

// Official package identifiers for the Node.js LTS line, in the same order of preference used for
// agents: a real package manager first, and the download page as the always-available fallback.
const NODE_INSTALL_METHODS: InstallMethod[] = [
  {
    id: 'winget',
    command:
      'winget install --accept-source-agreements --accept-package-agreements OpenJS.NodeJS.LTS',
    requires: 'winget',
    platforms: WINDOWS,
    verifyCommand: 'npm',
  },
  {
    id: 'scoop',
    command: 'scoop install nodejs-lts',
    requires: 'scoop',
    platforms: WINDOWS,
    verifyCommand: 'npm',
  },
  {
    id: 'choco',
    command: 'choco install -y nodejs-lts',
    requires: 'choco',
    platforms: WINDOWS,
    verifyCommand: 'npm',
  },
  // Homebrew's `node@<lts>` formulae are keg-only and never land on PATH; `node` is linked.
  {
    id: 'brew',
    command: 'brew install node',
    requires: 'brew',
    platforms: UNIX,
    verifyCommand: 'npm',
  },
]

/**
 * True when the agent would be installable here if Node were present: it has installers, but every
 * one of them needs npm and npm is missing. Agents with a native installer never qualify.
 */
export function needsNodeToolchain(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  platform: InstallPlatform = currentInstallPlatform(),
): boolean {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry || entry.methods.length === 0) return false
  if (installMethodsFor(agent, toolchain, platform).length > 0) return false
  return entry.methods.some((method) => method.requires === 'npm')
}

/** Node installers that work on this machine, best first. Empty means "send them to the website". */
export function nodeInstallMethods(
  toolchain: InstallToolchain | null,
  platform: InstallPlatform = currentInstallPlatform(),
): InstallMethod[] {
  if (!toolchain) return []
  return availableMethods(NODE_INSTALL_METHODS, toolchain, platform)
}

/**
 * Methods that run inside a WSL distro. Only the untagged ones qualify: the distro install runs a
 * plain argv (see `installArgv`), which a POSIX installer pipeline cannot be.
 */
export function wslInstallMethodsFor(agent: AgentType): InstallMethod[] {
  const methods = AGENT_INSTALL_CATALOG[agent]?.methods ?? []
  return methods.filter((method) => {
    if (method.platforms) return false
    if (WINDOWS_ONLY_METHODS.includes(method.id)) return false
    return !POWERSHELL_INSTALLER.test(method.command)
  })
}

// Every documented install command ends in the package or package id, so the uninstall counterpart
// is derived from it rather than duplicated in the catalog.
const UNINSTALL_TEMPLATE: Partial<
  Record<InstallMethodId, (target: string, command: string) => string>
> = {
  npm: (target) => `npm uninstall -g ${target}`,
  brew: (target, command) =>
    /\s--cask\s/.test(command) ? `brew uninstall --cask ${target}` : `brew uninstall ${target}`,
  winget: (target) => `winget uninstall --accept-source-agreements ${target}`,
  scoop: (target) => `scoop uninstall ${target}`,
  choco: (target) => `choco uninstall ${target} -y`,
}

/**
 * How this agent can be removed on this machine, best first. `native` installers are skipped: no
 * package manager tracks what a script installed, and guessing would delete the wrong thing. An
 * empty list means "we cannot remove it for you".
 */
export function uninstallMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  platform: InstallPlatform = currentInstallPlatform(),
): InstallMethod[] {
  return installMethodsFor(agent, toolchain, platform).flatMap((method) => {
    const template = UNINSTALL_TEMPLATE[method.id]
    if (!template) return []
    const target = method.command.trim().split(/\s+/).pop()
    if (!target) return []
    return [{ ...method, command: template(target, method.command), verifyAbsent: true }]
  })
}

/**
 * The line the install PTY runs as its command, so the shell ends with the installer and the caller
 * can trust `pty://exit`. It is NOT typed into an interactive shell: a pasted `exit` depends on the
 * person's shell profile behaving, and when it does not the run never reports back and the install
 * appears to hang forever. On Windows the exit code has to be forwarded explicitly, or PowerShell
 * reports success for an installer that failed.
 */
export function installCommandLine(command: string): string {
  return isWindows() ? `${command}; exit $LASTEXITCODE` : command
}

/**
 * Environment for the hidden installer shell. Node ships `npm.ps1` next to `npm.cmd` and PowerShell
 * picks the script, which the default `Restricted` policy of a fresh Windows refuses to run.
 * PowerShell reads its process-scope policy from this variable; it only reaches this shell, and
 * policies set through Group Policy still win.
 */
export const INSTALL_SHELL_ENV = { PSExecutionPolicyPreference: 'RemoteSigned' }

/** Line handed to the shell PTY: run the installer, then close the shell. */
export function installShellLine(command: string): string {
  return `${command}; exit\r`
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

/** Installer output is raw PTY bytes; strip the escape sequences before rendering it as text. */
export function stripInstallLogAnsi(log: string): string {
  return log.replace(ANSI_PATTERN, '')
}

const SHELL_SYNTAX = /[|&;<>$`(){}'"\n\\]/

export function installArgv(command: string): { program: string; args: string[] } | null {
  if (SHELL_SYNTAX.test(command)) return null
  const tokens = command.trim().split(/\s+/)
  const [program, ...args] = tokens
  if (!program) return null
  return { program, args }
}
