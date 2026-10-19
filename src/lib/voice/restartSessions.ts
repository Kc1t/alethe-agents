import { useProjectsStore } from '../../stores/projectsStore'
import { useTerminalsStore } from '../../stores/terminalsStore'
import { useUiStore } from '../../stores/uiStore'
import { useVoiceConversationStore } from '../../stores/voiceConversationStore'
import { restartAgentTab } from '../agentTabRestart'
import { graphifyRepoOf } from '../claudeMcpConfigs'
import { getLocale, translate } from '../i18n'
import { agentVoiceHookedPtys } from '../tauri'
import { staleSessions } from './target'

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate(getLocale(), key, params)

/** Asks Rust which PTYs carry the voice hooks now; the picker and the controller read the store. */
async function refreshHooked(): Promise<string[] | null> {
  try {
    const ids = await agentVoiceHookedPtys()
    useVoiceConversationStore.getState().patch({ voiceHookedPtyIds: ids })
    return ids
  } catch {
    return null
  }
}

/** `staleSessions` over the workspace as it is now. */
const currentStaleSessions = (hooked: readonly string[]) =>
  staleSessions(useProjectsStore.getState().projects, useTerminalsStore.getState().byPtyId, hooked)

/**
 * Restarts the Claude session in `ptyId` the way the pane's restart button does, resuming its
 * conversation; voice being on, the relaunch carries the voice hooks and the session becomes a
 * target. Checked again when it runs, since the picker or toast it came from may be stale: false
 * when the session is gone, already has the hooks, sits in a disabled pane, or the restart failed
 * (said in a toast).
 */
export async function restartVoiceSession(ptyId: string): Promise<boolean> {
  const hooked = await refreshHooked()
  if (!hooked) return false
  const session = currentStaleSessions(hooked).find((item) => item.ptyId === ptyId)
  if (!session) return false
  const project = useProjectsStore.getState().projects.find((item) => item.id === session.projectId)
  const terminal = project?.terminals.find((item) => item.id === session.terminalId)
  const tab = terminal?.tabs.find((item) => item.id === session.tabId)
  if (!project || !terminal || !tab) return false
  try {
    await restartAgentTab({
      projectId: project.id,
      terminalId: terminal.id,
      terminalCwd: terminal.cwd,
      tab,
      graphifyRepo: graphifyRepoOf(project, terminal.cwd),
    })
  } catch (cause) {
    useUiStore.getState().pushToast({ title: t('ui.terminal.restartFailed'), body: String(cause) })
    return false
  }
  await refreshHooked()
  return true
}

/** Restarts, one after the other, every session that still needs it when this runs. */
async function restartStaleSessions(): Promise<void> {
  const hooked = await refreshHooked()
  if (!hooked) return
  for (const session of currentStaleSessions(hooked)) await restartVoiceSession(session.ptyId)
}

/**
 * Voice was just turned on: Claude sessions already running were launched without its hooks, so
 * offer to restart them all (each resuming its conversation).
 */
export async function offerVoiceRestart(): Promise<void> {
  const hooked = await refreshHooked()
  if (!hooked) return
  const count = currentStaleSessions(hooked).length
  if (count === 0) return
  useUiStore.getState().pushToast({
    // zh-CN has no plural, so its singular string keeps `{count}`.
    title: t(count === 1 ? 'voice.conv.restartNeededOne' : 'voice.conv.restartNeeded', { count }),
    body: '',
    actions: [
      {
        label: t('voice.conv.restartNow'),
        run: () => void restartStaleSessions(),
      },
    ],
  })
}
