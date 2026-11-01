import { flushProjectsState, useProjectsStore } from '../stores/projectsStore'
import { agentLabel } from './agentProviders'
import type { RemoteOpenAgentEvent } from './tauri'

/**
 * Starts the agent a paired device asked for, shared so the device can open it. Returns the new
 * terminal id, or null when the request no longer matches a project or an enabled agent.
 */
export function openRemoteAgent(event: RemoteOpenAgentEvent): string | null {
  const store = useProjectsStore.getState()
  const project = store.projects.find((candidate) => candidate.id === event.projectId)
  if (!project || !store.preferences.enabledAgents[event.agent]) return null
  const terminal = store.createTerminal(project.id, {
    name: agentLabel(event.agent),
    cwd: '',
    firstTab: { type: event.agent, cwd: '' },
  })
  store.setTerminalRemoteShared(project.id, terminal.id, true)
  // The PTY spawns once its pane mounts, so the desktop has to show it.
  store.openTerminalWorkspace(project.id, terminal.id)
  // The device lists terminals from projects.json; skip the save debounce.
  void flushProjectsState()
  return terminal.id
}
