import { useProjectsStore } from '../stores/projectsStore'
import { launchContextForPty, launcherOverrideFor, prepareAgentLaunch } from './agentLaunchPlan'
import { resolveAgentCliCommand } from './agentProviders'
import { registerSessionClaim, releaseSessionClaim } from './sessionDiscovery'
import { saveSession } from './sessionResume'
import { restartPty } from './tauri'
import type { AgentRuntimeProfile, AgentType } from './types'

export type ResumeSessionInPaneParams = {
  agent: AgentType
  projectId: string
  terminalId: string
  tabId: string
  ptyId: string
  sessionId: string
  cwd: string
  extraArgs?: string[]
  runtimeProfile?: AgentRuntimeProfile
}

/**
 * Points a live pane at another conversation. The restart itself is the easy half — the claim
 * handoff, the `active-sessions` record and the tab's own `sessionId` all have to move with it,
 * or the pane resumes one conversation while the sidebar and the next app start believe another.
 */
export async function resumeSessionInPane({
  agent,
  projectId,
  terminalId,
  tabId,
  ptyId,
  sessionId,
  cwd,
  extraArgs,
  runtimeProfile,
}: ResumeSessionInPaneParams): Promise<void> {
  releaseSessionClaim(tabId)
  releaseSessionClaim(ptyId)

  const launch = await prepareAgentLaunch({
    agent,
    ptyId,
    cwd,
    extraArgs,
    runtimeProfile,
    resumeId: sessionId,
    ...launchContextForPty(ptyId),
  })
  if (!launch) return

  await restartPty({
    id: ptyId,
    cols: 80,
    rows: 24,
    command: resolveAgentCliCommand(agent),
    cwd: cwd || undefined,
    extraArgs: launch.args,
    launcherOverride: launcherOverrideFor(agent),
    env: launch.env,
  })

  if (cwd) {
    registerSessionClaim(agent, cwd, sessionId, tabId)
    registerSessionClaim(agent, cwd, sessionId, ptyId)
  }
  saveSession(tabId, {
    sessionId: ptyId,
    claudeSessionId: agent === 'claude' ? sessionId : undefined,
    codexSessionId: agent === 'codex' ? sessionId : undefined,
    opencodeSessionId: agent === 'opencode' ? sessionId : undefined,
    antigravitySessionId: agent === 'antigravity' ? sessionId : undefined,
    cwd,
    agent,
    timestamp: Date.now(),
  })
  useProjectsStore.getState().setSubTabSessionId(projectId, terminalId, tabId, sessionId)

  window.dispatchEvent(new CustomEvent('alethe:terminal-resize-request', { detail: { ptyId } }))
}
