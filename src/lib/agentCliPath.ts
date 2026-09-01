import { basename } from './paths'
import { agentCliCommand, type AgentType } from './types'

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat|ps1)$/i

/**
 * Whether the picked file looks like the agent's CLI rather than something else that carries the
 * vendor's name. Antigravity is the case this exists for: its CLI is `agy`, while `antigravity.exe`
 * is the desktop app — pointing an override at the app launches a window instead of a terminal.
 */
export function cliPathMatchesAgent(agent: AgentType, path: string): boolean {
  const expected = agentCliCommand(agent)
  if (!expected) return true
  const file = basename(path).toLowerCase().replace(EXECUTABLE_SUFFIX, '')
  return file === expected.toLowerCase()
}
