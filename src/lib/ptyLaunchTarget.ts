import { useProjectsStore } from '../stores/projectsStore'
import { agentCliCommand, type AgentType } from './types'

/**
 * What to spawn for a tab: the agent CLI, or — for a plain shell tab, which has no CLI — the shell
 * the user configured. Both fields derive from the same tab type, so they are returned together and
 * spread into `spawnPty`/`restartPty`; keeping them apart let restart paths drop the shell override.
 *
 * The backend ignores an override that no longer resolves to a file, so a stale setting degrades to
 * the per-platform auto-detect instead of failing the spawn.
 *
 * Bare shells spawned outside a tab (the agent installer's `irm … | iex` pipelines) deliberately do
 * not come through here: they need the detected PowerShell, not the user's shell of choice.
 */
export function ptyLaunchTarget(type: AgentType | null | undefined): {
  command: string | undefined
  launcherOverride: string | undefined
} {
  const command = type ? agentCliCommand(type) : undefined
  if (command) return { command, launcherOverride: undefined }
  return {
    command: undefined,
    launcherOverride: useProjectsStore.getState().preferences.shellPath ?? undefined,
  }
}
