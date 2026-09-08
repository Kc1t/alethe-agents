import { agentConfigRoot } from './api/misc'

/**
 * The environment an agent is launched with, including Alethe's own configuration directory.
 *
 * OpenCode reads its configuration from `XDG_CONFIG_HOME`, so pointing that at Alethe's directory
 * gives the agent a clean environment Alethe manages rather than whatever the machine happens to
 * have. Only configuration moves: sessions, credentials and snapshots live in OpenCode's separate
 * data directory, so history and login are unaffected.
 *
 * This lives in one place because it was in two. Spawning a terminal applied it and restarting one
 * did not, so an agent that started isolated silently returned to the machine's global
 * configuration the first time it was restarted — reading a different file from the one the MCP
 * manager edits, with nothing to say so. Every path that launches an agent has to go through here.
 */
export async function agentLaunchEnv(
  command: string | null | undefined,
  baseEnv?: Record<string, string> | null,
): Promise<Record<string, string> | undefined> {
  const env = baseEnv ?? undefined
  if (command !== 'opencode') return env

  const configRoot = await agentConfigRoot().catch((error) => {
    // Falling back to the ambient configuration is better than refusing to start, but it has to be
    // visible: the agent then reads a different file from the one the MCP manager edits.
    console.error('[agent-launch] could not resolve the agent config root:', error)
    return null
  })
  if (!configRoot) return env
  return { ...(env ?? {}), XDG_CONFIG_HOME: configRoot }
}
