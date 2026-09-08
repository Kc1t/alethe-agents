import { agentCliCommand, type AgentType } from './types'

export function buildGhosttyCommand(type: AgentType, extraArgs?: string[]): string | undefined {
  const command = agentCliCommand(type)
  if (!command) return undefined
  const parts = [command, ...(extraArgs ?? []).map(shellQuote)]
  return parts.join(' ')
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:@]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, "'\\''")}'`
}
