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

export type InstallMethod = {
  id: InstallMethodId
  command: string
  requires?: keyof InstallToolchain
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
// shell PTY. Verified against each vendor's official install documentation.
export const AGENT_INSTALL_CATALOG: Partial<Record<AgentType, AgentInstallCatalogEntry>> = {
  claude: {
    docsUrl: 'https://code.claude.com/docs/en/setup',
    methods: [
      { id: 'native', command: 'irm https://claude.ai/install.ps1 | iex' },
      { id: 'winget', command: 'winget install Anthropic.ClaudeCode', requires: 'winget' },
      { id: 'npm', command: 'npm install -g @anthropic-ai/claude-code', requires: 'npm' },
    ],
  },
  codex: {
    docsUrl: 'https://github.com/openai/codex',
    methods: [
      { id: 'native', command: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
      { id: 'npm', command: 'npm install -g @openai/codex', requires: 'npm' },
    ],
  },
  copilot: {
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    methods: [
      { id: 'winget', command: 'winget install GitHub.Copilot', requires: 'winget' },
      { id: 'npm', command: 'npm install -g @github/copilot', requires: 'npm' },
    ],
  },
  antigravity: {
    docsUrl: 'https://antigravity.google/docs/cli/install',
    methods: [{ id: 'native', command: 'irm https://antigravity.google/cli/install.ps1 | iex' }],
  },
  mimo: {
    docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code',
    methods: [
      { id: 'native', command: 'irm https://mimo.xiaomi.com/install.ps1 | iex' },
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
      { id: 'npm', command: 'npm install -g opencode-ai', requires: 'npm' },
      { id: 'scoop', command: 'scoop install opencode', requires: 'scoop' },
      { id: 'choco', command: 'choco install opencode', requires: 'choco' },
    ],
  },
}

export function installDocsUrl(agent: AgentType): string | undefined {
  return AGENT_INSTALL_CATALOG[agent]?.docsUrl
}

/**
 * Methods that will actually work on this machine, best first. A method without
 * `requires` needs nothing beyond a shell, so it always qualifies.
 */
export function installMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
): InstallMethod[] {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry) return []
  return entry.methods
    .filter((method) => {
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
    command: 'winget install OpenJS.NodeJS.LTS',
    requires: 'winget',
    verifyCommand: 'npm',
  },
  { id: 'scoop', command: 'scoop install nodejs-lts', requires: 'scoop', verifyCommand: 'npm' },
  { id: 'choco', command: 'choco install nodejs-lts', requires: 'choco', verifyCommand: 'npm' },
]

/**
 * True when the agent would be installable here if Node were present: it has installers, but every
 * one of them needs npm and npm is missing. Agents with a native installer never qualify.
 */
export function needsNodeToolchain(agent: AgentType, toolchain: InstallToolchain | null): boolean {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry || entry.methods.length === 0) return false
  if (installMethodsFor(agent, toolchain).length > 0) return false
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
): InstallMethod[] {
  return installMethodsFor(agent, toolchain).flatMap((method) => {
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
