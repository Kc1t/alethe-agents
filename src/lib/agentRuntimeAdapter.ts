import { applyLaunchDefaults } from './agentLaunchDefaults'
import {
  type AgentLaunchDefaults,
  type AgentRuntimeProfile,
  type AgentType,
  isShellAgentType,
} from './types'

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

function addArg(args: string[], value: string): void {
  if (!args.includes(value)) args.push(value)
}

export function preparePtyRuntimeLaunch(
  agent: AgentType,
  profile: AgentRuntimeProfile = 'full',
  baseArgs: readonly string[] = [],
  baseEnv?: Record<string, string>,
  // Resolved by the caller: this stays a pure function, and the model is decided per launch rather
  // than stored on the tab, so changing the preference reaches a pane on its next restart.
  defaults?: AgentLaunchDefaults,
): PreparedRuntimeLaunch {
  const args = applyLaunchDefaults(agent, baseArgs, defaults)
  const env = { ...(baseEnv ?? {}) }

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
