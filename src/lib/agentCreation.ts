import { AGENT_TYPE_LABELS, type AgentType, ALL_AGENT_TYPES, UNRESTRICTED_FLAG } from './types'

export const AGENT_OPTIONS = ALL_AGENT_TYPES.map((type) => ({
  type,
  label: AGENT_TYPE_LABELS[type],
}))

export const SHELL_FIRST_AGENT_OPTIONS = [
  ...AGENT_OPTIONS.filter((agent) => agent.type === 'shell'),
  ...AGENT_OPTIONS.filter((agent) => agent.type !== 'shell'),
]

export function createUnrestrictedAgentState(enabled = false): Record<AgentType, boolean> {
  return Object.fromEntries(ALL_AGENT_TYPES.map((type) => [type, enabled])) as Record<
    AgentType,
    boolean
  >
}

export function unrestrictedArgsForAgent(
  type: AgentType,
  unrestricted: Record<AgentType, boolean>,
): string[] | undefined {
  const flag = UNRESTRICTED_FLAG[type]
  return unrestricted[type] && flag ? [flag] : undefined
}
