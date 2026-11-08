import { useProjectsStore } from '../stores/projectsStore'
import { relaunchAgentPty } from './agentRelaunch'
import {
  conversationFields,
  getActiveSessions,
  savedConversationIdFor,
  saveSession,
} from './sessionResume'
import { getPtyCwd } from './tauri'
import type { SubTab } from './types'

// Throws when the relaunch fails; `tab.ptyId` must be set.
export async function restartAgentTab({
  projectId,
  terminalId,
  terminalCwd,
  tab,
  graphifyRepo,
}: {
  projectId: string
  terminalId: string
  terminalCwd?: string
  tab: SubTab
  graphifyRepo?: string | null
}): Promise<void> {
  const ptyId = tab.ptyId
  if (!ptyId) throw new Error('terminal_not_running')
  let restartCwd = (tab.cwd || terminalCwd || '').trim()
  if (!restartCwd) {
    restartCwd = ((await getPtyCwd(ptyId).catch(() => null)) ?? '').trim()
  }
  const activeSessions = getActiveSessions()
  const savedSession = activeSessions[tab.id] ?? activeSessions[ptyId] ?? null
  const resumeSessionId =
    tab.sessionId ?? savedConversationIdFor(savedSession, tab.type, restartCwd)

  const launch = await relaunchAgentPty({
    ptyId,
    agent: tab.type,
    runtimeProfile: tab.runtimeProfile,
    extraArgs: tab.extraArgs,
    sessionId: resumeSessionId,
    cwd: restartCwd,
    graphifyRepo,
    runAsAdmin: tab.runAsAdmin,
  })
  if (launch.sessionId && launch.sessionId !== tab.sessionId) {
    useProjectsStore.getState().setSubTabSessionId(projectId, terminalId, tab.id, launch.sessionId)
  }
  if (launch.sessionId) {
    saveSession(tab.id, {
      sessionId: ptyId,
      ...conversationFields(tab.type, launch.sessionId),
      cwd: restartCwd,
      agent: tab.type,
      timestamp: Date.now(),
    })
  }
  window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))
}
