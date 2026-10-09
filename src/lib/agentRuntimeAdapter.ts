import { isShellAgentType, type AgentRuntimeProfile, type AgentType } from './types'

export type AgentRuntimeBackend = 'pty' | 'codex-app-server' | 'claude-agent-sdk'

export type AgentRuntimeAdapter = {
  id: AgentRuntimeBackend
  label: string
  experimental: boolean
  available: boolean
  agents: AgentType[]
}

export const AGENT_RUNTIME_ADAPTERS: AgentRuntimeAdapter[] = [
  {
    id: 'pty',
    label: 'PTY / ConPTY',
    experimental: false,
    available: true,
    agents: [
      'shell',
      'wsl',
      'claude',
      'codex',
      'cursor',
      'opencode',
      'freebuff',
      'mimo',
      'kiro',
      'kimi',
      'grok',
      'codewhale',
    ],
  },
  {
    id: 'codex-app-server',
    label: 'Codex app-server',
    experimental: true,
    available: false,
    agents: ['codex'],
  },
  {
    id: 'claude-agent-sdk',
    label: 'Claude Agent SDK',
    experimental: true,
    available: false,
    agents: ['claude'],
  },
]

export type PreparedRuntimeLaunch = {
  args: string[]
  env: Record<string, string> | undefined
}

export type AgentLaunchOptions = {
  /**
   * Claude Code's fullscreen renderer takes the alternate screen and the mouse, which keeps the
   * wheel and the scrollback inside the agent. Off — the default — launches the classic renderer,
   * the ground Codex gets with `--no-alt-screen`, so the pane keeps scrolling and searching.
   */
  claudeFullscreen?: boolean
}

function addArg(args: string[], value: string): void {
  if (!args.includes(value)) args.push(value)
}

export function preparePtyRuntimeLaunch(
  agent: AgentType,
  profile: AgentRuntimeProfile = 'full',
  baseArgs: readonly string[] = [],
  baseEnv?: Record<string, string>,
  options: AgentLaunchOptions = {},
): PreparedRuntimeLaunch {
  const args = [...baseArgs]
  const env = { ...(baseEnv ?? {}) }

  // Renderer choice is not a runtime-profile concern, so it applies to every Claude launch.
  if (agent === 'claude' && !options.claudeFullscreen) {
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1'
  }

  if (profile === 'full' || isShellAgentType(agent)) {
    return { args, env: Object.keys(env).length > 0 ? env : undefined }
  }

  if (agent === 'claude') {
    env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY = '4'
    env.MCP_SERVER_CONNECTION_BATCH_SIZE = '1'
    env.ENABLE_TOOL_SEARCH = 'true'
    if (profile === 'diagnostic') addArg(args, '--safe-mode')
  }

  if (agent === 'codex') {
    addArg(args, '--no-alt-screen')
  }

  return { args, env: Object.keys(env).length > 0 ? env : undefined }
}
