import { isWindows } from './platform'
import type { AgentType } from './types'

export type InstallToolchain = {
  node: string | null
  npm: boolean
  winget: boolean
  scoop: boolean
  choco: boolean
  bun: boolean
  pnpm: boolean
}

export type InstallMethodId = 'native' | 'npm' | 'winget' | 'scoop' | 'choco'

/** Which shell a command is written for: PowerShell on Windows, a POSIX shell everywhere else. */
export type InstallOs = 'windows' | 'unix'

export function currentInstallOs(): InstallOs {
  return isWindows() ? 'windows' : 'unix'
}

export type InstallMethod = {
  id: InstallMethodId
  command: string
  requires?: keyof InstallToolchain
  /** The only OS the command runs on. Absent means any, as with npm. */
  os?: InstallOs
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

const METHOD_ORDER: InstallMethodId[] = ['native', 'npm', 'winget', 'scoop', 'choco']

// Commands are fixed literals, never user input: they are handed straight to a
// shell PTY. Verified against each vendor's official install documentation; the POSIX scripts were
// also fetched to confirm they exist and handle Linux.
export const AGENT_INSTALL_CATALOG: Partial<Record<AgentType, AgentInstallCatalogEntry>> = {
  claude: {
    docsUrl: 'https://code.claude.com/docs/en/setup',
    methods: [
      { id: 'native', os: 'windows', command: 'irm https://claude.ai/install.ps1 | iex' },
      { id: 'native', os: 'unix', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
      {
        id: 'winget',
        os: 'windows',
        command: 'winget install Anthropic.ClaudeCode',
        requires: 'winget',
      },
      { id: 'npm', command: 'npm install -g @anthropic-ai/claude-code', requires: 'npm' },
    ],
  },
  codex: {
    docsUrl: 'https://github.com/openai/codex',
    methods: [
      { id: 'native', os: 'windows', command: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
      { id: 'native', os: 'unix', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      { id: 'npm', command: 'npm install -g @openai/codex', requires: 'npm' },
    ],
  },
  copilot: {
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    methods: [
      { id: 'winget', os: 'windows', command: 'winget install GitHub.Copilot', requires: 'winget' },
      { id: 'npm', command: 'npm install -g @github/copilot', requires: 'npm' },
    ],
  },
  cursor: {
    docsUrl: 'https://cursor.com/docs/cli/installation',
    methods: [
      { id: 'native', os: 'windows', command: "irm 'https://cursor.com/install?win32=true' | iex" },
      { id: 'native', os: 'unix', command: 'curl https://cursor.com/install -fsS | bash' },
    ],
  },
  antigravity: {
    docsUrl: 'https://antigravity.google/docs/cli/install',
    methods: [
      {
        id: 'native',
        os: 'windows',
        command: 'irm https://antigravity.google/cli/install.ps1 | iex',
      },
      {
        id: 'native',
        os: 'unix',
        command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
    ],
  },
  mimo: {
    docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code',
    methods: [
      // There is no POSIX counterpart to this script (install.sh is a 404), so elsewhere it is npm.
      { id: 'native', os: 'windows', command: 'irm https://mimo.xiaomi.com/install.ps1 | iex' },
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
      { id: 'native', os: 'unix', command: 'curl -fsSL https://opencode.ai/install | bash' },
      { id: 'npm', command: 'npm install -g opencode-ai', requires: 'npm' },
      { id: 'scoop', os: 'windows', command: 'scoop install opencode', requires: 'scoop' },
      { id: 'choco', os: 'windows', command: 'choco install opencode', requires: 'choco' },
    ],
  },
  kiro: {
    docsUrl: 'https://kiro.dev/cli/',
    methods: [
      { id: 'native', os: 'windows', command: "irm 'https://cli.kiro.dev/install.ps1' | iex" },
      { id: 'native', os: 'unix', command: 'curl -fsSL https://cli.kiro.dev/install | bash' },
    ],
  },
  kimi: {
    docsUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html',
    methods: [{ id: 'npm', command: 'npm install -g @moonshot-ai/kimi-code', requires: 'npm' }],
  },
  grok: {
    docsUrl: 'https://docs.x.ai/build/overview',
    methods: [
      { id: 'native', os: 'windows', command: 'irm https://x.ai/cli/install.ps1 | iex' },
      { id: 'native', os: 'unix', command: 'curl -fsSL https://x.ai/cli/install.sh | bash' },
      { id: 'npm', command: 'npm install -g @xai-official/grok', requires: 'npm' },
    ],
  },
  codewhale: {
    docsUrl: 'https://codewhale.net/en',
    methods: [{ id: 'npm', command: 'npm install -g codewhale', requires: 'npm' }],
  },
}

export function installDocsUrl(agent: AgentType): string | undefined {
  return AGENT_INSTALL_CATALOG[agent]?.docsUrl
}

/**
 * Methods that will actually work on this machine, best first. A method without
 * `requires` needs nothing beyond a shell, so it qualifies on the OS it is written for.
 */
export function installMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: InstallOs = currentInstallOs(),
): InstallMethod[] {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry) return []
  return entry.methods
    .filter((method) => {
      if (method.os && method.os !== os) return false
      if (!method.requires) return true
      if (!toolchain) return false
      return Boolean(toolchain[method.requires])
    })
    .sort((a, b) => METHOD_ORDER.indexOf(a.id) - METHOD_ORDER.indexOf(b.id))
}

// Official package identifiers for the Node.js LTS line, in the same order of preference used for
// agents: a real package manager first, and the download page as the always-available fallback.
const NODE_INSTALL_METHODS: InstallMethod[] = [
  {
    id: 'winget',
    os: 'windows',
    command: 'winget install OpenJS.NodeJS.LTS',
    requires: 'winget',
    verifyCommand: 'npm',
  },
  {
    id: 'scoop',
    os: 'windows',
    command: 'scoop install nodejs-lts',
    requires: 'scoop',
    verifyCommand: 'npm',
  },
  {
    id: 'choco',
    os: 'windows',
    command: 'choco install nodejs-lts',
    requires: 'choco',
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
  os: InstallOs = currentInstallOs(),
): boolean {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry || entry.methods.length === 0) return false
  if (installMethodsFor(agent, toolchain, os).length > 0) return false
  return entry.methods.some((method) => method.requires === 'npm')
}

/** Node installers that work on this machine, best first. Empty means "send them to the website". */
export function nodeInstallMethods(toolchain: InstallToolchain | null): InstallMethod[] {
  if (!toolchain) return []
  return NODE_INSTALL_METHODS.filter((method) =>
    method.requires ? Boolean(toolchain[method.requires]) : true,
  )
}

// Every documented install command ends in the package or package id, so the uninstall counterpart
// is derived from it rather than duplicated in the catalog.
const UNINSTALL_TEMPLATE: Partial<Record<InstallMethodId, (target: string) => string>> = {
  npm: (target) => `npm uninstall -g ${target}`,
  winget: (target) => `winget uninstall ${target}`,
  scoop: (target) => `scoop uninstall ${target}`,
  choco: (target) => `choco uninstall ${target} -y`,
}

/**
 * How this agent can be removed on this machine, best first. `native` installers are skipped: none
 * of the vendors documents an uninstall for their install script, and guessing would delete the
 * wrong thing. An empty list means "we cannot remove it for you".
 */
export function uninstallMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: InstallOs = currentInstallOs(),
): InstallMethod[] {
  return installMethodsFor(agent, toolchain, os).flatMap((method) => {
    const template = UNINSTALL_TEMPLATE[method.id]
    if (!template) return []
    const target = method.command.trim().split(/\s+/).pop()
    if (!target) return []
    return [{ ...method, command: template(target), verifyAbsent: true }]
  })
}

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
