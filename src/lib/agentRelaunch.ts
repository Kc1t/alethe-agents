import { useProjectsStore } from '../stores/projectsStore'
import { useTerminalsStore } from '../stores/terminalsStore'
import { preparePtyRuntimeLaunch } from './agentRuntimeAdapter'
import { claudeLaunchExtras, recordClaudeLaunch } from './claudeMcpConfigs'
import { ptyLaunchTarget } from './ptyLaunchTarget'
import { type AgentLaunch, buildAgentLaunch } from './sessionLaunch'
import { restartPty } from './tauri'
import type { AgentRuntimeProfile, AgentType } from './types'

/**
 * Replaces the process in a pane's pty with a fresh launch of its agent. Every relaunch goes
 * through here so a Claude pane always gets its MCP servers and hooks back, which it only reads at
 * launch (#248). Throws when the restart fails; the launch is only recorded once it went through.
 */
export async function relaunchAgentPty({
  ptyId,
  agent,
  runtimeProfile,
  extraArgs,
  sessionId,
  cwd,
  graphifyRepo,
}: {
  ptyId: string
  agent: AgentType
  runtimeProfile?: AgentRuntimeProfile
  extraArgs?: string[]
  sessionId?: string
  cwd?: string
  graphifyRepo?: string | null
}): Promise<AgentLaunch> {
  const prepared = preparePtyRuntimeLaunch(agent, runtimeProfile, extraArgs ?? [], undefined, {
    claudeFullscreen: useProjectsStore.getState().preferences.claudeFullscreen,
  })
  const extras =
    agent === 'claude' ? await claudeLaunchExtras({ ptyId, cwd, graphifyRepo }) : undefined
  const launch = buildAgentLaunch(
    agent,
    prepared.args,
    sessionId,
    undefined,
    extras?.mcpConfigPaths,
    extras?.hooksSettingsPath,
  )
  useTerminalsStore.getState().beginRestart(ptyId)
  await restartPty({
    id: ptyId,
    cols: 80,
    rows: 24,
    // A plain shell tab has no CLI and restarts on the shell chosen in Preferences, if any.
    ...ptyLaunchTarget(agent),
    cwd: cwd || undefined,
    extraArgs: launch.args,
    env: prepared.env,
  })
  if (extras) recordClaudeLaunch(ptyId, extras.orchestrator)
  return launch
}
